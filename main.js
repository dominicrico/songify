require('dotenv').config()

const express = require('express')
const axios = require('axios')
const qs = require('querystring')
const fs = require('fs')
const formidable = require('express-formidable')

const CLIENT_ID_SLACK = process.env.SLACKIFY_CLIENT_ID_SLACK
const CLIENT_SECRET_SLACK = process.env.SLACKIFY_CLIENT_SECRET_SLACK
const REDIRECT_URI_SLACK = process.env.SLACKIFY_REDIRECT_URI_SLACK

const CLIENT_ID_SPOTIFY = process.env.SLACKIFY_CLIENT_ID_SPOTIFY
const CLIENT_SECRET_SPOTIFY = process.env.SLACKIFY_CLIENT_SECRET_SPOTIFY
const REDIRECT_URI_SPOTIFY = process.env.SLACKIFY_REDIRECT_URI_SPOTIFY

let newUser
const users = require('./users.json')
const emoji = require('./emoji.json')

const app = express()
app.use(formidable())

const refreshSpotifyToken = (user, cb) => {
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

      getCurrentSpotifyTrack(user)
    }).catch(err => {
      console.log(err)
      return res.status(500).json(err)
    })
}

const setUserStatus = (user) => {
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
    .catch(err => {
      console.log(err)

      return res.status(500).json(err)
    })
}

const getCurrentGenres = (user, artists) => {
  const opts = {
    headers: {
      'Authorization': `Bearer ${user.spotify_token}`
    }
  }

  return axios.get(`https://api.spotify.com/v1/artists/${artists[0].id}`, opts)
    .then(body => body.data.genres)
    .then(genres => {
      return new Promise((resolve, reject) => {
        genres.forEach((genre, i) => {
          let found = false

          if (emoji[genre] !== undefined && found === false) {
            found = true;
            return resolve(emoji[genre])
          }

          if (i === genres.length - 1 && found !== true) return resolve(undefined)
        })
      })
    })
}

const getCurrentSpotifyTrack = (user) => {
  const opts = {
    headers: {
      'Authorization': `Bearer ${user.spotify_token}`
    }
  }

  axios.get('https://api.spotify.com/v1/me/player/currently-playing', opts)
    .then(body => body.data)
    .then(async (body) => {
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
      if (err.response.status !== 429 && user.spotify_refresh) {
        return refreshSpotifyToken(user)
      } else {
        console.log(err.message, err.response)
      }
    })
}

setInterval(() => {
  users.forEach((user) => {
    if (user.pause_slackify !== true) {
      getCurrentSpotifyTrack(user)
    }
  })
}, 3000)

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'))
app.get('/privacy', (req, res) => res.sendFile(__dirname + '/privacy.html'))
app.get('/legal', (req, res) => res.redirect('https://meetrico.de/imprint'))

app.get('/connect', (req, res) => {
  return res.redirect(`https://slack.com/oauth/authorize?client_id=${CLIENT_ID_SLACK}&scope=users.profile:write users.profile:read commands&redirect_uri=${REDIRECT_URI_SLACK}`)
})

app.get('/slack/redirect', (req, res) => {
  const opts = {
    url: `https://slack.com/api/oauth.access?code=${req.query.code}&client_id=${CLIENT_ID_SLACK}&client_secret=${CLIENT_SECRET_SLACK}&redirect_uri=${REDIRECT_URI_SLACK}`,
    method: 'GET',
    responseType: 'json'
  }

  axios(opts)
    .then(body => body.data)
    .then(body => {

      newUser = {
        slack_token: body.access_token,
        spotify_token: null,
        spotify_refresh: null,
        status: null,
        user_id: body.user_id,
        team_id: body.team_id
      }

      return res.redirect(`https://accounts.spotify.com/authorize?response_type=code&client_id=${CLIENT_ID_SPOTIFY}&scope=user-read-currently-playing user-modify-playback-state&redirect_uri=${REDIRECT_URI_SPOTIFY}`)
    }).catch(err => {
      console.log(err)
      res.status(500).json(err)
    })
})

app.get('/spotify/redirect', (req, res) => {
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

        console.log(body)

        newUser.original_emoji = body.profile.status_emoji
        newUser.original_status = body.profile.status_text

        users.forEach((user, i) => {
          if (found === false && user.user_id === newUser.user_id && user.team_id === newUser.team_id) {
            found = true
            users[i] = newUser
          }
        })

        if (!found) users.push(newUser)

        fs.writeFile(`${__dirname}/users.json`, JSON.stringify(users), (err) => {
          return res.redirect('slack://')
        })
      })


    }).catch(err => {
      console.log(err)
      res.status(500).json(err)
    })
})

const addSongToQueue = (req, res) => {
  let slack_user = req.fields.user_id
  const u_id = req.fields.text.replace(/<@(\w+)\|.+>/g, '$1')
  let slack_user_found = false

  users.forEach(user => {
    if (user.user_id === slack_user) {
      slack_user_found = true
      slack_user = user
      let spotify_user_found = false

      users.forEach(user => {
        if (user.user_id === u_id) {
          const spotify_user = user
          spotify_user_found = true

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

                  if (err.response.data.error.status === 401) {
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

                        addSongToQueue(req, res)
                      }).catch(err => {
                        console.log(err)

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
              console.log(err.response.data)

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
        }
      })

      if (!spotify_user_found) {
        const userName = req.fields.text.replace(/<@\w+\|(.+)>/gi)

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
                "text": `If ${userName} doesn't use Slackify, you have to get him hooked up! Or he/she is not listening to music right now!?`
              }
            }
          ]
        })
      }
    }
  })

  if (!slack_user_found) {
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

const setEmojiForGenre = (req, res) => {
  let slack_user = req.fields.user_id

  users.forEach(user => {
    if (user.user_id === slack_user) {
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
              .then(genres => {
                const emojiForGenre = genres[0]

                if (emoji[emojiForGenre] !== undefined) {
                  return res.status(200).json({
                    "blocks": [
                      {
                        "type": "section",
                        "text": {
                          "type": "mrkdwn",
                          "text": `*There is already an emoji for the genre "${emojiForGenre}"...  :-1:*`
                        }
                      }
                    ]
                  })
                }

                emoji[emojiForGenre] = req.fields.text.match(/:\w+:/g)[0]

                fs.writeFile(`${__dirname}/emoji.json`, JSON.stringify(emoji), (err) => {
                  if (err) {
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
                  }

                  const slackOpts = {
                    headers: {
                      'Authorization': `Bearer ${user.slack_token}`
                    }
                  }

                  axios.post('https://slack.com/api/users.profile.set', {
                      profile: {
                          status_text: user.status,
                          status_emoji: emoji[emojiForGenre],
                          status_expiration: 0
                      }
                  }, slackOpts)
                    .then(() => {
                      return res.status(200).json({
                        "blocks": [
                          {
                            "type": "section",
                            "text": {
                              "type": "mrkdwn",
                              "text": `*Hurray, for the genre "${emojiForGenre}" we will use the ${emoji[emojiForGenre]} emoji!  :+1:*`
                            }
                          }
                        ]
                      })
                    })
                    .catch(err => {
                      console.log(err.response.data)

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
                })
              })
          }
        })
        .catch(err => {
          console.log(err.response.data)

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

app.post('/command', (req, res) => {
  if (req.fields.ssl_check === '1') return res.sendStatus(200)

  if (req.fields.command && req.fields.command === '/slackify') {
    if (req.fields.text.indexOf('emote') === 0 || req.fields.text.indexOf('emoji') === 0) {
      if (req.fields.text.match(/:\w+:/g) !== null) {
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
    } else if (req.fields.text === 'pause') {
      let slack_user = req.fields.user_id

      users.forEach(user => {
        if (user.user_id === slack_user) {
          user.pause_slackify = true
        }
      })

      fs.writeFile(`${__dirname}/users.json`, JSON.stringify(users), () => {
        return res.status(200).json({
          "blocks": [
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": "*Slackify is paused! You can start slackify again with /slackify resume.  :sob:*"
              }
            }
          ]
        })
      })
    } else if (req.fields.text === 'unpause' || req.fields.text === 'resume' ) {
      let slack_user = req.fields.user_id

      users.forEach(user => {
        if (user.user_id === slack_user) {
          user.pause_slackify = false
        }
      })

      fs.writeFile(`${__dirname}/users.json`, JSON.stringify(users), () => {
        return res.status(200).json({
          "blocks": [{
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": "*Slackify is running again!  :kissing_heart:*"
            }
          }]
        })
      })
    } else {
      return addSongToQueue(req, res)
    }
  } else {
    return res.status(200).json({
      "blocks": [
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": "*Sorry, but I don't understand this command...  :-1:*"
          }
        }
      ]
    })
  }
})

app.post('/events', (req, res) => {
  if (req.fields.event && req.fields.event.type === 'tokens_revoked') {
    users.forEach((user, i) => {
      if (user.user_id === req.fields.event.tokens.oauth[0]) {
        users.splice(i, 1)

        fs.writeFile(`${__dirname}/users.json`, JSON.stringify(users), () => {
          console.log('Benutzer gelöscht.')
        })
      }
    })
  } else if (req.fields.type === 'url_verification') {
    return res.status(200).send(req.fields.challenge)
  }

  return res.sendStatus(200)
})

app.listen(7869, () => console.log('slackify running on that one port you said it should run on...'))
