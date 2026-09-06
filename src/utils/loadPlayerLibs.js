import Hls from 'hls.js'
import videojs from 'video.js'
import dashjs from 'dashjs'

export async function loadVideojs() {
  return videojs.default || videojs
}

export async function loadHls() {
  return Hls
}

export async function loadDashjs() {
  return dashjs.default || dashjs
}
