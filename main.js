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

const app = express()
app.use(formidable())

const emoji = {
  deathcore: ':punch:',
  alternative: ':punch:',
  metalcore: ':punch:',
  hardcore: ':punch:',
  metal: ':punch:',
  rock: ':punch:',
  beatdown: ':punch:',
  heavymetal: ':punch:',
  hiphop: ':sunglasses:',
  'hip-hop': ':sunglasses:',
  'hip hop': ':sunglasses:',
  'deep german hip hop': ':sunglasses:',
  'german cloud rap': ':sunglasses:',
  'emo rap': ':sunglasses:',
  rap: ':sunglasses:',
  gangsterrap: ':sunglasses:',
  deutschrap: ':sunglasses:',
  rnb: ':sunglasses:',
  'r-n-b': ':sunglasses:',
  techno: ':pill:',
  house: ':pill:',
  acid: ':pill:',
  electro: ':pill:',
  minimal: ':pill:',
  goa: ':pill:'
}

const refreshSpotifyToken = (user) => {
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
      user.spotify_refresh = body.refresh_token

      getCurrentSpotifyTrack(user)
    }).catch(err => {
      console.log(err)
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
      } else if (user.status !== '') {
        user.genre = null
        user.status = ''
        setUserStatus(user)
      }

    }).catch(err => {
      if (user.spotify_refresh) return refreshSpotifyToken(user)
    })
}

setInterval(() => {
  users.forEach((user) => {
    getCurrentSpotifyTrack(user)
  })
}, 5000)

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'))
app.get('/privacy', (req, res) => res.sendFile(__dirname + '/privacy.html'))
app.get('/legal', (req, res) => res.redirect('https://meetrico.de/imprint'))

app.get('/connect', (req, res) => {
  return res.redirect(`https://slack.com/oauth/authorize?client_id=${CLIENT_ID_SLACK}&scope=users.profile:write&redirect_uri=${REDIRECT_URI_SLACK}`)
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

      return res.redirect(`https://accounts.spotify.com/authorize?response_type=code&client_id=${CLIENT_ID_SPOTIFY}&scope=user-read-currently-playing&redirect_uri=${REDIRECT_URI_SPOTIFY}`)
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

      let found = false
      users.forEach((user, i) => {
        if (found === false && user.user_id === newUser.user_id && user.team_id === newUser.team_id) {
          found = true
          users[i] = newUser
        }
      })

      if (!found) users.push(newUser)

      fs.writeFile(`${__dirname}/users.json`, JSON.stringify(users), (err) => {
        return res.status(200).json('Es geht los... Verbunden!')
      })
    }).catch(err => {
      console.log(err)
      res.status(500).json(err)
    })
})

app.post('/events', (req, res) => {
  console.log(req.fields)

  if (req.fields.event && req.fields.event.type === 'tokens_revoked') {
    users.forEach((user, i) => {
      if (user.user_id === req.fields.event.tokens.oauth[0]) {
        users.splice(i, 1)

        fs.writeFile(`${__dirname}/users.json`, JSON.stringify(users), (err) => {
          return res.status(200).json('Schade!')
        })
      }
    })
  }

  return res.sendStatus(200)
})

app.listen(7869, () => console.log('slackify running on that one port you said it should run on...'))
// app.listen(8080, () => console.log('slackify running on that one port you said it should run on...'))
