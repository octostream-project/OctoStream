const path = require('path')

let mpvPlayer = null
let vlcPlayer = null

try {
  mpvPlayer = require(path.join(__dirname, 'mpv_player', 'build', 'Release', 'mpv_player.node'))
} catch {
  // mpv_player native module not available
}

try {
  vlcPlayer = require(path.join(__dirname, 'vlc_player', 'build', 'Release', 'vlc_player.node'))
} catch {
  // vlc_player native module not available
}

module.exports = {
  mpvAvailable: !!mpvPlayer,
  vlcAvailable: !!vlcPlayer,
  MpvPlayer: mpvPlayer?.MpvPlayer,
  VlcPlayer: vlcPlayer?.VlcPlayer,
}
