const fs = require('fs')
const express = require('express')
const config = require('./config')
const bodyParser = require('body-parser')
const util = require('util')
const app = express()
const server = require('http').Server(app)
const io = require('socket.io')(server)
const mysql = require('mysql')
const morgan = require('morgan')
const { execSync, execFile } = require('child_process')
const uuid = require('uuid/v1')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')

const secretKey = fs.readFileSync('secret.key')

const pool = mysql.createPool({
  connectionLimit: 10,
  host: config.dbHost,
  user: config.dbUser,
  password: config.dbPw,
  database: config.dbName
})

const query = util.promisify(pool.query).bind(pool)

/**
 * Verifies the supplied token belongs to a user. If `eventId` is supplied in the request body, the user must also have access to that event.
 * @param {*} req 
 * @param {*} res 
 * @param {*} next 
 */
function requireUser(req, res, next) {
  let tokenHeader = req.get('Authorization')
  let tokenMatch = /Bearer (.*)/.exec(tokenHeader)
  if (!tokenMatch) return accessDenied(res)
  let token = tokenMatch[1]

  let user = jwt.decode(token)
  req.user = user
  next()
}

/**
 * Verifies the supplied token belongs to an admin.
 * @param {*} req 
 * @param {*} res 
 * @param {*} next 
 */
function requireAdmin(req, res, next) {
  let tokenHeader = req.get('Authorization')
  let tokenMatch = /Bearer (.*)/.exec(tokenHeader)
  if (!tokenMatch) return accessDenied(res)
  let token = tokenMatch[1]

  let user = jwt.decode(token)
  req.user = user
  if (!user.admin) return accessDenied(res)
  next()
}

function accessDenied(res) {
  res.json({ error: 'Access denied' })
}

app.use(morgan('dev'))

app.use(bodyParser.json({       // to support JSON-encoded bodies
  limit: '10mb'
}))
app.use(bodyParser.urlencoded({     // to support URL-encoded bodies
  extended: true,
  limit: '10mb'
}))

app.use(function (req, res, next) {
  res.header("Access-Control-Allow-Origin", "*")
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept")
  if (req.method === 'OPTIONS') {
    res.sendStatus(200)
    return
  }
  next()
})

app.post('/api/v4/user/login', async (req, res) => {
  let user = await query('SELECT * FROM Users WHERE username = ?', [req.body.username])

  if (user.length === 1) {
    user = user[0]
    console.log(req.body.password, user.password)
    let correct = req.body.password === user.password
    // let correct = await bcrypt.compare(req.body.password, user.password)
    if (correct) {
      jwt.sign({ userId: user.userId, username: user.username, admin: user.admin, eventIds: user.eventIds },
        secretKey,
        (err, token) => {
          if (err) {
            console.error(err)
            return res.json({ error: 'An unexpected error occurred.' })
          }
          delete user.password
          return res.json({ token, user })
        })
    } else {
      return res.json({ error: 'Incorrect username or password.' })
    }
  } else {
    return res.json({ error: 'Incorrect username or password.' })
  }
})

app.get('/api/v4/user/verify', requireUser, (req, res) => {
  if (req.user) {
    res.json({ user: req.user })
  } else {
    res.json({ error: 'Invalid token' })
  }
})

app.get('/api/v4/user/all', requireAdmin, async (req, res) => {
  let users = await query('SELECT userId, username, admin from Users')
  res.json(users)
})

app.post('/api/v4/user/update', requireAdmin, async (req, res) => {
  if (!req.body.username || req.body.username === '') return res.json({ error: 'username is required' })
  if (req.body.userId == null) return res.json({ error: 'userId is required' })
  let results = await query('UPDATE Users SET ? WHERE userId = ?', [req.body, req.body.userId])
  if (results.affectedRows === 1) {
    let update = [{ table: 'user', data: [req.body] }]
    res.json({ success: true, update })
    pushUpdate(update)
  } else {
    res.json({ error: 'User not found' })
  }
})

app.post('/api/v4/user/create', requireAdmin, async (req, res) => {
  if (!req.body.username || req.body.username === '') return res.json({ error: 'username is required' })
  if (!req.body.password) return res.json({ error: 'password is required' })

  try {
    let results = await query('INSERT into Users SET ?', [req.body])
    // res.json({ success: true, insertId: results.insertId })
    let update = [{ table: 'user', data: [{ ...req.body, userId: results.insertId }] }]
    res.json({ success: true, update })
    pushUpdate(update)
  } catch (ex) {
    res.json({ error: ex.message })
  }
})

app.post('/api/v4/user/delete', requireAdmin, async (req, res) => {
  if (req.body.userId == null) return res.json({ error: 'userId is required' })
  let results = await query('DELETE FROM Users WHERE userId = ?', [req.body.userId])
  if (results.affectedRows === 1) {
    let update = [{ table: 'user', data: { ids: [req.body.userId] }, deleted: true }]
    res.json({ success: true, update })
    pushUpdate(update)
  } else {
    res.json({ error: 'User not found' })
  }
})

app.post('/api/v3/mysqldump', (req, res) => {
  if (req.body.secret === config.secret) {
    const cmd = `mysql --database pinewood -u${config.dbUser} -p${config.dbPw}`
    try {
      var output = execSync(cmd, { maxBuffer: 1e7, input: req.body.sql, timeout: 3000 })
      res.json({ ok: true })
      io.emit('newdata')
    } catch (ex) {
      console.log(ex.toString())
      res.json({ error: ex })
    }
  } else {
    res.json({ error: 'Incorrect secret' })
  }
})


app.get('/api/v4/event/all', function (req, res) {
  var where = 'WHERE 1=1'
  var params = []
  if (!req.query.showHidden) {
    where += ' AND hidden=0'
  }
  if (req.query.hasOwnProperty('dayStart')) {
    where += ' AND DATEDIFF(eventDate, NOW()) >= ? '
    params.push(req.query.dayStart)
  }
  if (req.query.hasOwnProperty('dayEnd')) {
    where += ' AND DATEDIFF(eventDate, NOW()) < ? '
    params.push(req.query.dayEnd)
  }
  pool.query(`SELECT * FROM Events ${where} ORDER BY EventDate DESC`, params, function (err, rows) {
    if (err) {
      console.log(err)
      res.json({ error: err })
    }
    else {
      res.json(rows.map(fromBuffer))
    }
  })
})

app.get('/api/v4/event/get', function (req, res) {
  const params = [req.query.eventId]
  pool.query(`SELECT * FROM Events WHERE EventId = ?`, params, function (err, rows) {
    if (err) {
      console.log(err)
      res.json({ error: err })
    }
    else if (rows.length === 1) {
      res.json(rows.map(fromBuffer))
    } else {
      res.json({ error: 'Event not found' })
    }
  })
})

app.post('/api/v4/event/create', requireAdmin, async (req, res) => {
  if (!req.body.eventName || req.body.eventName === '') return res.json({ error: 'eventName is required' })
  if (!req.body.multiplier) return res.json({ error: 'multiplier is required' })

  try {
    let results = await query('INSERT into Events SET ?', [req.body])
    let insertedObject = await query('SELECT * FROM Events WHERE eventId = ?', [results.insertId])
    let update = [{ table: 'event', data: insertedObject.map(fromBuffer) }]
    res.json({ success: true, update })
    pushUpdate(update)
  } catch (ex) {
    res.json({ error: ex.message })
  }
})


app.post('/api/v4/event/update', requireAdmin, async (req, res) => {
  if (!req.body.eventName || req.body.eventName === '') return res.json({ error: 'eventName is required' })
  if (!req.body.eventId || req.body.eventId === '') return res.json({ error: 'eventId is required' })
  if (!req.body.multiplier) return res.json({ error: 'multiplier is required' })

  try {
    let results = await query('UPDATE Events SET ? WHERE eventId = ?', [req.body, req.body.eventId])
    let updatedObject = await query('SELECT * FROM Events WHERE eventId = ?', [req.body.eventId])
    let update = [{ table: 'event', data: updatedObject.map(fromBuffer) }]
    res.json({ success: true, update })
    pushUpdate(update)
  } catch (ex) {
    res.json({ error: ex.message })
  }
})

app.post('/api/v4/event/delete', requireAdmin, async (req, res) => {
  if (!req.body.eventId || req.body.eventId === '') return res.json({ error: 'eventId is required' })

  try {
    // TODO: Also remove cars and results
    let results = await query('DELETE FROM Events WHERE eventId = ?', [req.body.eventId])
    let update = [{ table: 'event', data: { ids: [req.body.eventId] }, deleted: true }]
    res.json({ success: true, update })
    pushUpdate(update)
  } catch (ex) {
    res.json({ error: ex.message })
  }
})


app.post('/api/v4/car/create', requireAdmin, async (req, res) => {
  if (!req.body.carName || req.body.carName === '') return res.json({ error: 'carName is required' })

  try {
    let imageData = req.body.imageData
    delete req.body.imageData
    req.body.imageVersion = Date.now()
    let results = await query('INSERT into Cars SET ?', [req.body])
    let insertedObject = await query('SELECT * FROM Cars WHERE carId = ?', [results.insertId])
    let update = [{ table: 'car', data: insertedObject.map(fromBuffer) }]
    if (imageData) {
      imageData = imageData.replace('data:image/jpeg;base64,', '')
      var filename = __dirname + "/public/cars/" + results.insertId + ".jpg"
      await fs.promises.writeFile(filename, imageData, "base64")
    }
    res.json({ success: true, update })
    pushUpdate(update)
  } catch (ex) {
    res.json({ error: ex.message })
  }
})

app.post('/api/v4/car/update', requireAdmin, async (req, res) => {
  if (!req.body.carName || req.body.carName === '') return res.json({ error: 'carName is required' })
  if (!req.body.carId) return res.json({ error: 'carId is required' })

  try {
    let imageData = req.body.imageData
    delete req.body.imageData
    req.body.imageVersion = Date.now()
    let results = await query('UPDATE Cars SET ? WHERE carId = ?', [req.body, req.body.carId])
    let updatedObject = await query('SELECT * FROM Cars WHERE carId = ?', [req.body.carId])
    let update = [{ table: 'car', data: updatedObject.map(fromBuffer) }]
    if (imageData) {
      imageData = imageData.replace('data:image/jpeg;base64,', '')
      var filename = __dirname + "/public/cars/" + req.body.carId + ".jpg"
      await fs.promises.writeFile(filename, imageData, "base64")
    }
    res.json({ success: true, update })
    pushUpdate(update)
  } catch (ex) {
    res.json({ error: ex.message })
  }
})

app.post('/api/v4/car/delete', requireAdmin, async (req, res) => {
  if (!req.body.carId || req.body.carId === '') return res.json({ error: 'carId is required' })

  try {
    // TODO: Also remove cars and results
    let results = await query('DELETE FROM Cars WHERE carId = ?', [req.body.carId])
    let update = [{ table: 'car', data: { ids: [req.body.carId] }, deleted: true }]
    res.json({ success: true, update })
    pushUpdate(update)
  } catch (ex) {
    res.json({ error: ex.message })
  }
})

app.get('/api/v4/car/getByEventId', function (req, res) {
  // Does not require the secret key (it would be public anyway)
  if (/^[0-9]+$/.test(req.query.eventId)) {
    pool.query("SELECT * FROM Cars WHERE eventId = ?", [req.query.eventId], function (err, rows) {
      if (err) {
        res.json({ error: err })
      }
      else {
        res.json(rows)
      }
    })
  }
})

app.get('/api/v4/result/getByEventId', function (req, res) {
  if (/^[0-9]+$/.test(req.query.eventId)) {
    pool.query("SELECT * FROM Results WHERE eventId = ?", [req.query.eventId], function (err, rows) {
      if (err) {
        res.json({ error: err })
      }
      else {
        res.json(rows)
      }
    })
  }
})

app.get('/api/v3/carsAndResultsByEventId', function (req, res) {
  if (/^[0-9]+$/.test(req.query.eventId)) {

    const carSql = `SELECT Cars.*, GROUP_CONCAT(DISTINCT Achievements.achievement SEPARATOR ', ') as allAchs FROM Cars 
    LEFT JOIN Achievements ON Cars.carId = Achievements.carId
    WHERE Cars.eventId = ?
    GROUP BY Cars.carId`

    pool.query(carSql, [req.query.eventId], function (err, cars) {
      if (err) {
        res.json({ error: err })
      }
      else {
        pool.query("SELECT * FROM Results WHERE eventId = ?", [req.query.eventId], function (err, results) {
          if (err) {
            res.json({ error: err })
          }
          else {
            res.json({ cars, results })
          }
        })
      }
    })
  }
})

// New style using HTML5 canvas and dataURL
app.post('/api/v3/checkin', function (req, res) {

  var checkInId = uuid()
  var carName = req.body.name
  var nickname = req.body.nickname
  var den = req.body.den

  console.log(carName)  // At this point, the unicode characters aren't working....
  // What are the headers?
  console.log(req.headers)

  // Add entry to database
  pool.query("INSERT INTO CheckIn SET ?", [{ checkInId, carName, nickname, den }], function (err) {
    if (err) {
      res.redirect('/check-in-failed')
      console.log(err)
      return
    }

    // Save file
    let preamble = 'data:image/jpeg;base64,'
    if (req.body.photo.startsWith(preamble)) {
      let outfile = __dirname + '/checkin/' + checkInId + '.jpg'
      let imgData = req.body.photo.substr(preamble.length)
      fs.writeFile(outfile, imgData, { encoding: 'base64' }, err => {
        if (err) {
          console.log(err)
          res.redirect('/check-in-failed')
          return
        }
        res.redirect('/check-in-confirmation')
      })
    }
  })
})


/*
// Old style using traditional file upload and resize on server
app.post('/api/v3/checkin', function (req, res) {
 
  console.log(req.body)
  console.log(req.files)
 
  var checkInId = uuid()
  var carName = req.body.name
  var nickname = req.body.nickname
  var den = req.body.den
 
  // Add entry to database
  conn.query("INSERT INTO CheckIn SET ?", [{ checkInId, carName, nickname, den }], function (err) {
    if (err) {
      res.redirect('/check-in-failed')
      console.log(err)
      return
    }
 
    inFile = __dirname + '/tmp/' + req.files.photo.name
    outFile = __dirname + '/checkin/' + checkInId + '.jpg'
 
    // Move file to temporary folder
    req.files.photo.mv(inFile, function (err) {
      if (err) {
        res.redirect('/check-in-failed')
        console.log(err)
        return
      }
 
      // Convert, resize, and crop
      execFile('convert', [inFile, '-resize', '640x480^', '-gravity', 'center', '-extent', '640x480', '-quality', '90', outFile], function (err) {
        if (err) {
          res.redirect('/check-in-failed')
          console.log(err)
          return
        }
        res.redirect('/check-in-confirmation')
      })
    })
  })
})
*/

app.post('/api/v3/checkinadded', function (req, res) {
  var checkInId = req.body.checkInId
  var addedToEventId = req.body.eventId
  pool.query("UPDATE CheckIn SET addedToEventId = ? WHERE checkInId = ?", [addedToEventId, checkInId], function (err) {
    if (err) {
      console.log(err)
      res.json({ error: err })
      return
    }
    res.json({ success: true })
  })
})

app.get('/api/v3/checkinlist', function (req, res) {
  if (req.query.secret === config.secret) {

    let where = 'WHERE 1 = 1'
    if (req.query.notAdded) {
      where += ' AND addedToEventId IS NULL'
    }
    if (req.query.recent) {
      where += ' AND DATEDIFF(NOW(), time) < 4'
    }
    let sql = `SELECT * FROM CheckIn ${where} ORDER BY time DESC`

    pool.query(sql, function (err, rows) {
      if (err) {
        console.log(err)
        res.json({ error: err })
        return
      }
      res.json(rows)
    })
  }
  else {
    res.json({ error: 'Incorrect secret' })
  }
})

app.post('/api/v3/vote', function (req, res) {
  // Does not require secret key
  if (req.body.votes) {
    var votes = req.body.votes.split(',')
    if (votes.length <= 3) {
      for (var i = 0; i < votes.length; i++) {
        var vote = votes[i]
        if (/[0-9]{1,9}/.test(vote)) {
          pool.query("INSERT INTO Votes(carId, Votes) VALUES(?, 1) ON DUPLICATE KEY UPDATE Votes = Votes + 1", [vote], function (err) {
            if (err) {
              console.log(err)
            }
          })
        }
      }
    }
  }
  // Every request results in an (almost) immediate and identical response; do not betray any secrets!
  res.json({ "message": "Thank you" })

})

app.post('/api/v3/carImage', function (req, res) {

  console.log(req.body)

  if (req.body.secret === config.secret) {

    // Validate req.body.Id if you value your life
    if (/[0-9]{1,9}/.test(req.body.Id)) {

      var filename = __dirname + "/cars/" + req.body.Id + ".jpg"
      if (req.body.imageData) {
        console.log("Writing " + filename)
        const imageData = req.body.imageData.replace('data:image/jpeg;base64,', '')
        fs.writeFile(filename, new Buffer(imageData, "base64"), err => {
          if (err) {
            console.log(err)
            return
          }
          res.json({ "result": "Image received" })
        })

      }
      else {
        // Check to see if image file exists.

        fs.stat(filename, function (err, stat) {
          if (err == null) {
            res.json({ "result": "Image exists" })
          }
          else if (err.code == 'ENOENT') {
            res.json({ "result": "Image does not exist" })
          }
          else {
            console.log('Some other error: ', err.code)
            res.json({ "err": err.code })
          }
        })
      }
    }
    else {
      res.json({ error: "Invalid Id" })
    }

  }
  else {
    res.status('403')
    console.log("Forbidden")
  }

})

app.get('/api/v3/cars/:id.jpg', function (req, res) {
  if (/[0-9]{1,9}/.test(req.params.id)) {
    var filename = __dirname + "/cars/" + req.params.id + ".jpg"
    res.sendFile(filename)
  }
})

app.get('/api/v3/checkin/:id.jpg', function (req, res) {
  if (/[0-9a-f\-]{36}/.test(req.params.id)) {
    var filename = __dirname + "/checkin/" + req.params.id + ".jpg"
    res.sendFile(filename)
  }
})

app.post('/api/v4/subscribe', requireUser, (req, res) => {
  let socket = sockets.find(s => s.id === req.body.socketId)
  if (socket) {
    if (!socket.models) socket.models = []
    for (let model of req.body.models) {
      if (!socket.models.includes(model)) {
        socket.models.push(model)
      }
    }
    console.log(`socket ${socket.id} is now subscribed to ${socket.models}`)
    res.json({ models: socket.models })
  } else {
    console.log(`socket ${req.body.socketId} not found`)
    res.json({ error: 'socket not found' })
  }

})

app.use(express.static(__dirname + '/public'))

app.use(function (req, res, next) {
  res.status(404)
  res.send({ error: 'Not found' })
})



const sockets = []
io.on('connection', socket => {
  sockets.push(socket)
  console.log('socket connected:' + socket.id)
})

function pushUpdate(update) {
  for (let socket of sockets) {
    let yourUpdate = update.filter(u => socket.models?.includes(u.table))
    // console.log(`socket ${socket.id} is receiving:`)
    // console.log(JSON.stringify(yourUpdate, null, 2))
    if (yourUpdate.length > 0) {
      socket.emit('update', yourUpdate)
    }
  }

}

function fromBuffer(row) {
  console.log(row)
  let keys = ['enableVoting', 'hidden']
  let converted = { ...row }
  for (let key of keys) {
    if (Buffer.isBuffer(converted[key])) {
      converted[key] = converted[key][0] === 1
    }
  }
  return converted
}

server.listen(config.expressPort, function () {
  console.log("Listening on *:" + config.expressPort)
})
