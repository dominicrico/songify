require('dotenv').config()

const express = require('express')
const axios = require('axios')
const qs = require('querystring')
const crypto = require('crypto')
const fs = require('fs')
const formidable = require('express-formidable')
const MongoClient = require('mongodb').MongoClient

const CLIENT_ID_SLACK = process.env.SONGIFY_CLIENT_ID_SLACK
const CLIENT_SECRET_SLACK = process.env.SONGIFY_CLIENT_SECRET_SLACK
const REDIRECT_URI_SLACK = process.env.SONGIFY_REDIRECT_URI_SLACK

const SIGNING_SECRET_SLACK = process.env.SONGIFY_SIGNING_SECRET_SLACK

const CLIENT_ID_SPOTIFY = process.env.SONGIFY_CLIENT_ID_SPOTIFY
const CLIENT_SECRET_SPOTIFY = process.env.SONGIFY_CLIENT_SECRET_SPOTIFY
const REDIRECT_URI_SPOTIFY = process.env.SONGIFY_REDIRECT_URI_SPOTIFY

const MONGO_PASSWORD = process.env.SONGIFY_MONGO_PASSWORD
const MONGO_USER = process.env.SONGIFY_MONGO_USER
const MONGO_URL = process.env.SONGIFY_MONGO_URL
const MONGO_DATABASE = process.env.SONGIFY_MONGO_DATABASE

const SONGIFY_COMMAND = process.env.SONGIFY_COMMAND
const SONGIFY_PORT = process.env.SONGIFY_PORT

console.log(`
  Current Env Vars used for Songify.io

  CLIENT_ID_SLACK: ${CLIENT_ID_SLACK}
  CLIENT_SECRET_SLACK: ${CLIENT_SECRET_SLACK}
  REDIRECT_URI_SLACK: ${REDIRECT_URI_SLACK}
  SIGNING_SECRET_SLACK: ${SIGNING_SECRET_SLACK}

  CLIENT_ID_SPOTIFY: ${CLIENT_ID_SPOTIFY}
  CLIENT_SECRET_SPOTIFY: ${CLIENT_SECRET_SPOTIFY}
  REDIRECT_URI_SPOTIFY: ${REDIRECT_URI_SPOTIFY}

  MONGO_PASSWORD: ${MONGO_PASSWORD}
  MONGO_USER: ${MONGO_USER}
  MONGO_DATABASE: ${MONGO_DATABASE}
  MONGO_URL: ${MONGO_URL}

  SONGIFY_COMMAND: ${SONGIFY_COMMAND}
  SONGIFY_PORT: ${SONGIFY_PORT}
`)

const url = `mongodb://${MONGO_USER}:${MONGO_PASSWORD}@${MONGO_URL}:20717/${MONGO_DATABASE}`

MongoClient.connect(url, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  ssl: true,
  authSource: 'admin',
  sslValidate: false
}).then(async client => {
  let newUser

  const User = client.db(MONGO_DATABASE).collection('users')
  const Genre = client.db(MONGO_DATABASE).collection('genres')
  const Log = client.db(MONGO_DATABASE).collection('logs')

  const createLogEntry = (action, service, message, user_id, isError) => {
    const createdAt = new Date()

    Log.insertOne({action, service, createdAt, message, user: user_id, error: isError})
  }

  const app = express()
  app.use(formidable())

  const fixedEncodeURIComponent = str => {
    return str.replace(/[!'()*~]/g, function (c) {
      return '%' + c.charCodeAt(0).toString(16).toUpperCase()
    })
  }

  const verifySlackRequest = (req) => {
    const xSlackRequestTimeStamp = req.get('X-Slack-Request-Timestamp')
    const slackSignature = req.get('X-Slack-Signature')
    const bodyPayload = fixedEncodeURIComponent(qs.stringify(req.fields).replace(/%20/g, '+')) // Fix for #1
    if (!(xSlackRequestTimeStamp && slackSignature && bodyPayload)) {
      return false
    }
    const baseString = `v0:${xSlackRequestTimeStamp}:${bodyPayload}`
    const hash = 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET_SLACK)
      .update(baseString)
      .digest('hex')

    return (slackSignature === hash)
  }

  const refreshSpotifyToken = (user) => {
    createLogEntry('refresh_token', 'spotify', null, user._id, false)

    const opts = {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }

    const body = {
      grant_type: 'refresh_token',
      refresh_token: user.spotify_refresh,
      client_id: CLIENT_ID_SPOTIFY,
      client_secret: CLIENT_SECRET_SPOTIFY
    }

    axios.post('https://accounts.spotify.com/api/token', qs.stringify(body), opts)
      .then(body => body.data)
      .then(body => {
        user.spotify_token = body.access_token

        createLogEntry('refresh_token_success', 'spotify', null, user._id, false)

        User.updateOne({user_id: user.user_id}, {$set: {...user}})
          .then(() => getCurrentSpotifyTrack(user))
      }).catch(err => {
        createLogEntry('refresh_token_failed', 'spotify', err.response.data, user._id, true)

        if (err.response.status === 400 && err.response.data && err.response.data.error === 'invalid_grant') {
          User.findOneAndDelete({user_id: user.user_id}).then(() => {
            createLogEntry('token_revoked', 'spotify', 'user_deleted', user._id, true)
          })
        }
      })
  }

  const setUserStatus = (user) => {
    createLogEntry('set_user_status', 'slack', null, user._id, false)

    const opts = {
      headers: {
        'Authorization': `Bearer ${user.slack_token}`
      }
    }

    axios.post('https://slack.com/api/users.profile.set', {
      profile: {
        status_text: user.status.length > 100 ? user.status.substring(0, 97) + '...' : user.status,
        status_emoji: user.genre ? user.genre : user.status.length > 0 ? ':notes:' : null,
        status_expiration: 0
      }
    }, opts)
      .then(() => {
        createLogEntry('set_user_status_success', 'slack', null, user._id, false)
        return User.updateOne({user_id: user.user_id}, {$set: {...user}})
      })
      .catch(err => {
        console.log(err)
        createLogEntry('set_user_status_failed', 'slack', err.response.data, user._id, true)
        return res.status(500).json(err)
      })
  }

  const getCurrentGenres = (user, artists) => {
    createLogEntry('get_current_genres', 'spotify', null, user._id, false)
    const opts = {
      headers: {
        'Authorization': `Bearer ${user.spotify_token}`
      }
    }

    return axios.get(`https://api.spotify.com/v1/artists/${artists[0].id}`, opts)
      .then(body => body.data.genres)
      .then(genres => {
        return new Promise((resolve, reject) => {
          Genre.findOne({genre: { $in : genres }, team_id: user.team_id})
            .then(genre => {
              createLogEntry('get_current_genres_success', 'spotify', genres, user._id, false)
              if (genre) {
                return resolve(genre.emoji)
              } else {
                return resolve(undefined)
              }
            }).catch(err => {
              createLogEntry('get_current_genres_failure', 'spotify', err.response.data, user._id, true)
              console.log(err)
              return resolve(undefined)
            })
        })
      })
  }

  const getCurrentSpotifyTrack = (user) => {
    createLogEntry('get_current_track', 'spotify', null, user._id, false)

    const opts = {
      headers: {
        'Authorization': `Bearer ${user.spotify_token}`
      }
    }

    axios.get('https://api.spotify.com/v1/me/player/currently-playing', opts)
      .then(body => body.data)
      .then(async (body) => {
        createLogEntry('get_current_track_success', 'spotify', body, user._id, false)

        if (body.item && body.item.artists) {
          const artists = body.item.artists.map(artist => artist.name)
          const track = `${artists.join(',')} - ${body.item.name}`

          if (track !== user.status || body.is_playing !== user.paused) {
            user.paused = body.is_playing
            user.status = track
            user.genre = body.is_playing === true ? await getCurrentGenres(user, body.item.artists) : ':double_vertical_bar:'
            setUserStatus(user)
          }
        } else if (user.status !== '' && user.status !== user.original_status) {
          user.genre = user.original_emoji
          user.status = user.original_status
          setUserStatus(user)
        }

      }).catch(err => {
        createLogEntry('get_current_track_failure', 'spotify', err.response.data, user._id, true)

        if (err.response.status !== 429 && user.spotify_refresh) {
          return refreshSpotifyToken(user)
        } else {
          console.log(err.message, err.response)
        }
      })
  }

  setInterval(() => {
    User.find({}).toArray().then(users => {
      users.forEach((user) => {
        if (user.pause_songify !== true) {
          getCurrentSpotifyTrack(user)
        }
      })
    })
  }, 3000)

  app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'))
  app.get('/privacy', (req, res) => res.sendFile(__dirname + '/privacy.html'))
  app.get('/legal', (req, res) => res.redirect('https://meetrico.de/imprint'))

  app.get('/connect', (req, res) => {
    createLogEntry('new_connection', 'songify', null, null, false)

    return res.redirect(`https://slack.com/oauth/v2/authorize?client_id=${CLIENT_ID_SLACK}&scope=commands&user_scope=users.profile:write,users.profile:read&redirect_uri=${REDIRECT_URI_SLACK}`)
  })

  app.get('/slack/redirect', (req, res) => {
    createLogEntry('new_connection', 'slack', null, null, false)

    const opts = {
      url: `https://slack.com/api/oauth.v2.access?code=${req.query.code}&client_id=${CLIENT_ID_SLACK}&client_secret=${CLIENT_SECRET_SLACK}&redirect_uri=${REDIRECT_URI_SLACK}`,
      method: 'GET',
      responseType: 'json'
    }

    axios(opts)
      .then(body => body.data)
      .then(body => {

        createLogEntry('new_connection_success', 'slack', null, null, false)

        newUser = {
          slack_token: body.authed_user.access_token,
          spotify_token: null,
          spotify_refresh: null,
          status: null,
          user_id: body.authed_user.id,
          team_id: body.team.id
        }

        return res.redirect(`https://accounts.spotify.com/authorize?response_type=code&client_id=${CLIENT_ID_SPOTIFY}&scope=user-read-currently-playing user-modify-playback-state&redirect_uri=${REDIRECT_URI_SPOTIFY}`)
      }).catch(err => {
        createLogEntry('new_connection_failure', 'slack', err.response.data, null, true)
        res.status(500).json(err)
      })
  })

  app.get('/spotify/redirect', (req, res) => {
    createLogEntry('new_connection', 'spotify', null, null, false)

    const opts = {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }

    const body = {
      grant_type: 'authorization_code',
      code: req.query.code,
      redirect_uri: REDIRECT_URI_SPOTIFY,
      client_id: CLIENT_ID_SPOTIFY,
      client_secret: CLIENT_SECRET_SPOTIFY
    }

    axios.post('https://accounts.spotify.com/api/token', qs.stringify(body), opts)
      .then(body => body.data)
      .then(body => {

        createLogEntry('new_connection_success', 'spotify', null, null, false)

        newUser.spotify_token = body.access_token
        newUser.spotify_refresh = body.refresh_token

        axios.get('https://slack.com/api/users.profile.get', {
          headers: {
            'Authorization': `Bearer ${newUser.slack_token}`
          }
        })
        .then(body => body.data)
        .then(body => {
          let found = false

          newUser.original_emoji = body.profile.status_emoji
          newUser.original_status = body.profile.status_text

          User.updateOne({user_id: newUser.user_id}, {$set: {...newUser}}, {upsert: true}).then(() => {
            return res.sendFile(__dirname + '/success.html')
          })
        })

      }).catch(err => {
        createLogEntry('new_connection_failure', 'spotify', err.response.data, null, true)

        console.log(err)
        res.status(500).json(err)
      })
  })

  const addSongToQueue = async (req, res) => {
    let slack_user = req.fields.user_id
    const u_id = req.fields.text.replace(/<@(\w+)\|.+>/g, '$1')

    const sluser = await User.findOne({user_id: slack_user})

    createLogEntry('add_song_to_queue', 'spotify', null, sluser._id, false)

    if (sluser) {
      slack_user = sluser

      const spuser = await User.findOne({user_id: u_id})

      if (spuser) {
        const spotify_user = spuser

        const opts = {
          headers: {
            'Authorization': `Bearer ${spotify_user.spotify_token}`
          }
        }

        axios.get('https://api.spotify.com/v1/me/player/currently-playing', opts)
          .then(body => body.data)
          .then(body => {
            if (body.item.uri) {
              axios({
                method: 'POST',
                url: `https://api.spotify.com/v1/me/player/queue?uri=${body.item.uri}`,
                headers: {
                  'Authorization': `Bearer ${slack_user.spotify_token}`
                }
              }).then(song => {
                const artists = body.item.artists.map(artist => artist.name)

                createLogEntry('add_song_to_queue_success', 'spotify', null, sluser._id, false)

                return res.status(200).json({
                  "blocks": [
                    {
                      "type": "section",
                      "text": {
                        "type": "mrkdwn",
                        "text": "*Song was added to your Spotify queue :+1:*"
                      }
                    },
                    {
                      "type": "section",
                      "text": {
                        "type": "mrkdwn",
                        "text": `${artists.join(',')} - ${body.item.name}`
                      }
                    }
                  ]
                })
              }).catch(err => {
                console.log(err.response.data)

                createLogEntry('add_song_to_queue_failure', 'spotify', err.response.data, sluser._id, true)

                if (err.response.data.error.status === 401) {

                  createLogEntry('refresh_token', 'spotify', null, slack_user._id, false)

                  const opts = {
                    headers: {
                      'Content-Type': 'application/x-www-form-urlencoded'
                    }
                  }

                  const body = {
                    grant_type: 'refresh_token',
                    refresh_token: slack_user.spotify_refresh,
                    client_id: CLIENT_ID_SPOTIFY,
                    client_secret: CLIENT_SECRET_SPOTIFY
                  }

                  axios.post('https://accounts.spotify.com/api/token', qs.stringify(body), opts)
                    .then(body => body.data)
                    .then(body => {
                      slack_user.spotify_token = body.access_token
                      slack_user.spotify_refresh = body.refresh_token

                      createLogEntry('refresh_token_success', 'spotify', null, slack_user._id, false)

                      User.updateOne({user_id: slack_user.user_id}, {$set: {...slack_user}}, {upsert: true}).then(() => {
                        addSongToQueue(req, res)
                      }).catch(err => {
                        return res.status(200).json({
                          "blocks": [
                            {
                              "type": "section",
                              "text": {
                                "type": "mrkdwn",
                                "text": "*Song could not be added to your Spotify queue. :-1:*"
                              }
                            },
                            {
                              "type": "section",
                              "text": {
                                "type": "mrkdwn",
                                "text": `Seems like there is an error with Spotify...`
                              }
                            }
                          ]
                        })
                      })
                    }).catch(err => {
                      console.log(err)

                      createLogEntry('add_song_to_queue_failure', 'spotify', err.response.data, sluser._id, true)

                      if (err.response.status === 400 && err.response.data && err.response.data.error === 'invalid_grant') {
                        User.findOneAndDelete({user_id: user.user_id}).then(() => {
                          createLogEntry('token_revoked', 'spotify', 'user_deleted', user._id, true)
                        })
                      }

                      return res.status(200).json({
                        "blocks": [
                          {
                            "type": "section",
                            "text": {
                              "type": "mrkdwn",
                              "text": "*Song could not be added to your Spotify queue. :-1:*"
                            }
                          },
                          {
                            "type": "section",
                            "text": {
                              "type": "mrkdwn",
                              "text": `Seems like there is an error with Spotify...`
                            }
                          }
                        ]
                      })
                    })
                } else {
                  return res.status(200).json({
                    "blocks": [
                      {
                        "type": "section",
                        "text": {
                          "type": "mrkdwn",
                          "text": "*Song could not be added to your Spotify queue. :-1:*"
                        }
                      },
                      {
                        "type": "section",
                        "text": {
                          "type": "mrkdwn",
                          "text": `Seems like there is an error with Spotify...`
                        }
                      }
                    ]
                  })
                }
              })
            }
          }).catch(err => {
            console.log(err.response)

            createLogEntry('add_song_to_queue_failure', 'spotify', err.response.data, sluser._id, true)

            return res.status(200).json({
              "blocks": [
                {
                  "type": "section",
                  "text": {
                    "type": "mrkdwn",
                    "text": "*Song could not be added to your Spotify queue. :-1:*"
                  }
                },
                {
                  "type": "section",
                  "text": {
                    "type": "mrkdwn",
                    "text": `Seems like there is an error with Spotify...`
                  }
                }
              ]
            })
          })
      } else {
        const userName = req.fields.text.replace(/<@\w+\|(.+)>/gi)

        createLogEntry('add_song_to_queue_failure', 'songify', 'no songify user found to add song', sluser._id, true)

        return res.status(200).json({
          "blocks": [
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": "*Song could not be added to your Spotify queue. :-1:*"
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `If ${userName} doesn't use Songify.io, you have to get him hooked up! Or he/she is not listening to music right now!?`
              }
            }
          ]
        })
      }
    } else {
      createLogEntry('add_song_to_queue_failure', 'songify', 'no songify user found to add song', sluser._id, true)

      return res.status(200).json({
        "blocks": [
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
                "text": "*Song could not be added to your Spotify queue. :-1:*"
            }
          },
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": `I could not find a Slack user with this name...`
            }
          }
        ]
      })
    }
  }

  const setEmojiForGenre = async (req, res) => {
    let slack_user = req.fields.user_id
    const team_id = req.fields.team_id

    const user = await User.findOne({user_id: slack_user})

    createLogEntry('set_genre_emoji', 'songify', null, user._id, false)

    if (user) {
      const opts = {
        headers: {
          'Authorization': `Bearer ${user.spotify_token}`
        }
      }

      axios.get('https://api.spotify.com/v1/me/player/currently-playing', opts)
        .then(body => body.data)
        .then(async (body) => {
          if (body.item && body.item.artists) {
            return axios.get(`https://api.spotify.com/v1/artists/${body.item.artists[0].id}`, opts)
              .then(body => body.data.genres)
              .then(async spotifyGenres => {
                const genres = await Genre.find({team_id, genre: {$in: spotifyGenres}}, {genre: 1, _id: 0}).toArray()
                const checkGenres = genres.map(g => g.genre)
                const newGenres = spotifyGenres.filter(g => checkGenres.indexOf(g) === -1)

                if (!spotifyGenres || spotifyGenres.length === 0) {
                  return res.status(200).json({
                    "blocks": [
                      {
                        "type": "section",
                        "text": {
                          "type": "mrkdwn",
                          "text": `*Sorry, but there is no genre listed on Spotify for that song...  :-1:*`
                        }
                      }
                    ]
                  })
                }

                if (!newGenres || newGenres.length === 0) {
                  return res.status(200).json({
                    "blocks": [
                      {
                        "type": "section",
                        "text": {
                          "type": "mrkdwn",
                          "text": `*There is already an emoji for these genres...  :-1:*`
                        }
                      }
                    ]
                  })
                }

                const data = newGenres.map(g => {
                  return {
                    team_id,
                    genre: g,
                    emoji: req.fields.text.match(/:\w+:/g)[0]
                  }
                })

                Genre.insertMany(data).then(doc => {
                  user.genre = data[0].emoji
                  setUserStatus(user)

                    return res.status(200).json({
                      "blocks": [
                        {
                          "type": "section",
                          "text": {
                            "type": "mrkdwn",
                            "text": `*Hurray, for the genres "${newGenres.join(', ')}" we will use the ${data[0].emoji} emoji!  :+1:*`
                          }
                        }
                      ]
                    })
                  })
                  .catch(err => {
                    console.log(err.response)

                    createLogEntry('set_genre_emoji_failure', 'songify',  err.message, user._id, true)

                    return res.status(200).json({
                      "blocks": [
                        {
                          "type": "section",
                          "text": {
                            "type": "mrkdwn",
                            "text": `*Something went wrong...  :-1:*`
                          }
                        },
                        {
                          "type": "section",
                          "text": {
                            "type": "mrkdwn",
                            "text": `${err.message}`
                          }
                        }
                      ]
                    })
                  })
                }).catch(err => {
                  createLogEntry('set_genre_emoji_failure', 'spotify',  err.response.data, user._id, true)

                  return res.status(200).json({
                    "blocks": [
                      {
                        "type": "section",
                        "text": {
                          "type": "mrkdwn",
                          "text": `*Something went wrong...  :-1:*`
                        }
                      },
                      {
                        "type": "section",
                        "text": {
                          "type": "mrkdwn",
                          "text": `${err.message}`
                        }
                      }
                    ]
                  })
                })
            .catch(err => {
              console.log(err.response)

              createLogEntry('set_genre_emoji_failure', 'spotify',  err.response.data, user._id, true)

              return res.status(200).json({
                "blocks": [
                  {
                    "type": "section",
                    "text": {
                      "type": "mrkdwn",
                      "text": `*Something went wrong...  :-1:*`
                    }
                  },
                  {
                    "type": "section",
                    "text": {
                      "type": "mrkdwn",
                      "text": `${err.message}`
                    }
                  }
                ]
              })
            })
          }
        })
    }
  }

  app.post('/command', async (req, res) => {
    if (!verifySlackRequest(req)) return res.sendStatus(403)

    if (req.fields.ssl_check === '1') return res.sendStatus(200)

    const user = await User.findOne({user_id: req.fields.user_id})

    createLogEntry('received_command', 'slack', {command: req.fields.command, text: req.fields.text} , user._id, false)

    if (req.fields.command && req.fields.command === SONGIFY_COMMAND) {
      if (req.fields.text.indexOf('emote') === 0 || req.fields.text.indexOf('emoji') === 0) {
        if (req.fields.text.match(/:.+:/g) !== null) {
          return setEmojiForGenre(req, res)
        } else {
          return res.status(200).json({
            "blocks": [
              {
                "type": "section",
                "text": {
                  "type": "mrkdwn",
                  "text": "*Sorry, but if you want to add an emoji for a genre, you should send me one...  :-1:*"
                }
              }
            ]
          })
        }
      } else if (req.fields.text.indexOf('status') === 0) {
        const status = req.fields.text.replace(/status(\s:.+:)?\s(\w+)/, '$2')
        const emote = req.fields.text.match(/:.+:/g)
        const overwrite = {}

        if (status) overwrite.original_status = status
        if (emote) overwrite.original_emoji = emote

        User.updateOne({user_id: req.fields.user_id}, {$set: overwrite }).then(user => {
          return res.status(200).json({
            "blocks": [
              {
                "type": "section",
                "text": {
                  "type": "mrkdwn",
                  "text": `*Your status when songify is not running is now set to: ${emote} ${status}*`
                }
              }
            ]
          })
        }).catch(err => {
          createLogEntry('received_command_failure', 'slack', err.message , user._id, true)

          return res.status(500).json({
            "blocks": [
              {
                "type": "section",
                "text": {
                  "type": "mrkdwn",
                  "text": "*Sorry, something went wrong... Please try it again."
                }
              }
            ]
          })
        })
      } else if (req.fields.text === 'pause') {
        User.updateOne({user_id: req.fields.user_id}, {$set: {pause_songify: true}}).then(user => {
          return res.status(200).json({
            "blocks": [
              {
                "type": "section",
                "text": {
                  "type": "mrkdwn",
                  "text": "*Songify.io is paused! You can start Songify.io again with /songify resume.  :sob:*"
                }
              }
            ]
          })
        }).catch(err => {
          createLogEntry('received_command_failure', 'slack', err.message , user._id, true)

          return res.status(500).json({
            "blocks": [
              {
                "type": "section",
                "text": {
                  "type": "mrkdwn",
                  "text": "*Sorry, something went wrong... Please try it again."
                }
              }
            ]
          })
        })
      } else if (req.fields.text === 'unpause' || req.fields.text === 'resume' ) {
        User.updateOne({user_id: req.fields.user_id},  {$set: {pause_songify: false}}).then(user => {
          return res.status(200).json({
            "blocks": [{
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": "*Songify.io is running again!  :kissing_heart:*"
              }
            }]
          })
        }).catch(err => {
          createLogEntry('received_command_failure', 'slack', err.message , user._id, true)

          return res.status(500).json({
            "blocks": [
              {
                "type": "section",
                "text": {
                  "type": "mrkdwn",
                  "text": "*Sorry, something went wrong... Please try it again."
                }
              }
            ]
          })
        })
      } else if (req.fields.text.match(/<@(\w+)\|.+>/g) !== null) {
        return addSongToQueue(req, res)
      } else {
        createLogEntry('received_command_failure', 'slack', 'unknown_command' , user._id, true)

        return res.status(200).json({
          "blocks": [
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": "*Sorry, but I don't understand this command...  :-1:*"
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": "Visit https://songify.io to see a full list of commands."
              }
            }
          ]
        })
      }
    } else {
      createLogEntry('received_command_failure', 'slack', 'unknown_command' , user._id, true)

      return res.status(200).json({
        "blocks": [
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": "*Sorry, but I don't understand this command...  :-1:*"
            }
          },
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": "Visit https://songify.io to see a full list of commands."
            }
          }
        ]
      })
    }
  })

  app.post('/events', (req, res) => {
    if (!verifySlackRequest(req)) return res.sendStatus(403)

    if (req.fields.event && req.fields.event.type === 'tokens_revoked') {
      const users = User.find({slack_token: { $in: req.fields.event.tokens.oauth }}).toArray()

      users.forEach(user => {
        createLogEntry('token_revoke', 'slack', null , user._id, false)

        User.findOneAndDelete({user_id: user.user_id}).then(() => {
          console.log('Benutzer gelöscht.')
          createLogEntry('token_revoke_success', 'slack', null , user._id, false)
        }).catch(err => {
          createLogEntry('token_revoke_failure', 'slack', err.message , user._id, true)
        })
      })

      return res.sendStatus(201)
    } else if (req.fields.type === 'url_verification') {
      return res.status(200).send(req.fields.challenge)
    }

    return res.sendStatus(200)
  })

  app.listen(SONGIFY_PORT, () => console.log(`Songify.io running on port ${SONGIFY_PORT}, you said it should run on...`))
}).catch(err => {
  console.log('MONGO ERROR:', err)
})
