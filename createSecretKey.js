const crypto = require('crypto')

let secretKey = crypto.generateKey('hmac', 256)

console.log(secretKey)