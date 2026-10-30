import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@octostream/exo-player', () => ({
  ExoPlayer: {
    addListener: vi.fn(),
    play: vi.fn(),
    readTextFile: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    seekTo: vi.fn(),
    setPlaybackRate: vi.fn(),
    setSubtitleStyle: vi.fn(() => Promise.resolve()),
    playEmbed: vi.fn(),
    resolveEmbed: vi.fn(),
  },
}))

vi.mock('./platform.js', () => ({
  isAndroidNative: vi.fn(),
  isElectron: vi.fn(() => false),
}))

import { ExoPlayer } from '@octostream/exo-player'
import { isAndroidNative } from './platform.js'
import {
  playStream,
  playLocalFile,
  pausePlayback,
  resumePlayback,
  stopPlayback,
  seekTo,
  setPlaybackRate,
  isExoPlayerAvailable,
  resolveEmbed,
} from './exoPlayer.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('isExoPlayerAvailable', () => {
  it('returns true on Android native', () => {
    isAndroidNative.mockReturnValue(true)
    expect(isExoPlayerAvailable()).toBe(true)
  })

  it('returns false on web or desktop', () => {
    isAndroidNative.mockReturnValue(false)
    expect(isExoPlayerAvailable()).toBe(false)
  })
})

describe('playStream', () => {
  it('throws if not on Android native', async () => {
    isAndroidNative.mockReturnValue(false)
    await expect(playStream({ url: 'https://example.com/video.m3u8' }))
      .rejects.toThrow('ExoPlayer only available on Android native')
    expect(ExoPlayer.play).not.toHaveBeenCalled()
  })

  it('calls ExoPlayer.play with defaults and provided options', async () => {
    isAndroidNative.mockReturnValue(true)
    ExoPlayer.play.mockResolvedValue({ status: 'ok' })

    const callback = vi.fn()
    await playStream(
      {
        url: 'https://example.com/video.m3u8',
        streamType: 'hls',
        title: 'Test',
      },
      callback,
    )

    expect(ExoPlayer.play).toHaveBeenCalledWith({
      url: 'https://example.com/video.m3u8',
      streamType: 'hls',
      direct: false,
      warpBound: false,
      bypassVpn: false,
      licenseUrl: null,
      headers: {},
      drmHeaders: {},
      title: 'Test',
      mode: 'vod',
      startTime: 0,
      channels: null,
      channelIndex: -1,
      epgNow: null,
      epgNext: null,
      epgStart: 0,
      epgEnd: 0,
      logo: '',
      imdbId: '',
      season: 0,
      episode: 0,
      subtitles: null,
      episodes: null,
      episodeIndex: -1,
      seasons: null,
      longBuffering: false,
      fastStart: false,
      loadingText: null,
    })
  })

  it('forwards the vps flag so debrid streams use the SSH forward', async () => {
    isAndroidNative.mockReturnValue(true)
    ExoPlayer.play.mockResolvedValue({ status: 'ok' })

    await playStream({
      url: 'https://cdn.example.com/file.mkv',
      streamType: 'mp4',
      vps: true,
    })

    expect(ExoPlayer.play).toHaveBeenCalledWith(expect.objectContaining({ vps: true }))
  })
})

describe('playLocalFile', () => {
  it('starts the video without waiting to read a subtitle from USB', async () => {
    isAndroidNative.mockReturnValue(true)
    ExoPlayer.play.mockResolvedValue({ status: 'playing' })
    const subtitles = [{ url: 'content://usb/sub.srt', mimeType: 'application/x-subrip' }]
    await playLocalFile({ uri: 'content://usb/video.mkv', subtitles, startTime: 0 })
    expect(ExoPlayer.readTextFile).not.toHaveBeenCalled()
    expect(ExoPlayer.play).toHaveBeenCalledWith(expect.objectContaining({
      url: 'content://usb/video.mkv', localFile: true, subtitles,
    }))
  })
})

describe('resolveEmbed', () => {
  it('returns failed off Android native without calling the plugin', async () => {
    isAndroidNative.mockReturnValue(false)
    const res = await resolveEmbed('https://example.com/e/abc')
    expect(res).toEqual({ status: 'failed' })
    expect(ExoPlayer.resolveEmbed).not.toHaveBeenCalled()
  })

  it('forwards url and timeout to the native plugin', async () => {
    isAndroidNative.mockReturnValue(true)
    ExoPlayer.resolveEmbed.mockResolvedValue({ status: 'resolved', url: 'https://cdn/x.m3u8', streamType: 'hls' })
    const res = await resolveEmbed('https://example.com/e/abc', 15000)
    expect(ExoPlayer.resolveEmbed).toHaveBeenCalledWith({ url: 'https://example.com/e/abc', timeout: 15000 })
    expect(res.status).toBe('resolved')
  })

  it('returns failed on invalid url', async () => {
    isAndroidNative.mockReturnValue(true)
    const res = await resolveEmbed('not-a-url')
    expect(res).toEqual({ status: 'failed' })
    expect(ExoPlayer.resolveEmbed).not.toHaveBeenCalled()
  })

  it('swallows native errors and returns failed', async () => {
    isAndroidNative.mockReturnValue(true)
    ExoPlayer.resolveEmbed.mockRejectedValue(new Error('boom'))
    const res = await resolveEmbed('https://example.com/e/abc')
    expect(res).toEqual({ status: 'failed' })
  })
})

describe('control methods', () => {
  beforeEach(() => {
    isAndroidNative.mockReturnValue(true)
  })

  it('pause calls native pause', async () => {
    ExoPlayer.pause.mockResolvedValue(undefined)
    await pausePlayback()
    expect(ExoPlayer.pause).toHaveBeenCalled()
  })

  it('resume calls native resume', async () => {
    ExoPlayer.resume.mockResolvedValue(undefined)
    await resumePlayback()
    expect(ExoPlayer.resume).toHaveBeenCalled()
  })

  it('stop calls native stop', async () => {
    ExoPlayer.stop.mockResolvedValue(undefined)
    await stopPlayback()
    expect(ExoPlayer.stop).toHaveBeenCalled()
  })

  it('seekTo forwards position', async () => {
    ExoPlayer.seekTo.mockResolvedValue(undefined)
    await seekTo(120)
    expect(ExoPlayer.seekTo).toHaveBeenCalledWith({ position: 120 })
  })

  it('setPlaybackRate forwards rate', async () => {
    ExoPlayer.setPlaybackRate.mockResolvedValue(undefined)
    await setPlaybackRate(1.5)
    expect(ExoPlayer.setPlaybackRate).toHaveBeenCalledWith({ rate: 1.5 })
  })

  it('control methods are no-ops off Android', async () => {
    isAndroidNative.mockReturnValue(false)
    await pausePlayback()
    await resumePlayback()
    await stopPlayback()
    await seekTo(60)
    await setPlaybackRate(2)
    expect(ExoPlayer.pause).not.toHaveBeenCalled()
    expect(ExoPlayer.resume).not.toHaveBeenCalled()
    expect(ExoPlayer.stop).not.toHaveBeenCalled()
    expect(ExoPlayer.seekTo).not.toHaveBeenCalled()
    expect(ExoPlayer.setPlaybackRate).not.toHaveBeenCalled()
  })
})
