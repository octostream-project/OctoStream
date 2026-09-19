import { WebPlugin } from '@capacitor/core'
import type { ExoPlayerPlugin, PlayOptions, PlayPipOptions, SeekOptions, RateOptions, PlayEmbedOptions, PlayEmbedResult, ResolveEmbedOptions, PlayRelayOptions, PlayRelayResult, SetChannelsOptions, SetEpisodesOptions, SwitchChannelOptions } from './definitions'

export class ExoPlayerWeb extends WebPlugin implements ExoPlayerPlugin {
  async play(_options: PlayOptions): Promise<{ status: string }> {
    throw new Error('ExoPlayer is only available on Android native')
  }

  async switchChannel(_options: SwitchChannelOptions): Promise<{ status: string }> {
    throw new Error('ExoPlayer is only available on Android native')
  }

  async setChannels(_options: SetChannelsOptions): Promise<void> {}

  async setEpisodes(_options: SetEpisodesOptions): Promise<void> {}

  async setNextEpisode(_options: { title?: string }): Promise<void> {}

  async setLoadingText(_options: { text: string }): Promise<void> {}

  async playEmbed(_options: PlayEmbedOptions): Promise<PlayEmbedResult> {
    throw new Error('ExoPlayer is only available on Android native')
  }

  async resolveEmbed(_options: ResolveEmbedOptions): Promise<PlayEmbedResult> {
    return { status: 'failed' }
  }

  async playRelay(_options: PlayRelayOptions): Promise<PlayRelayResult> {
    return { status: 'failed' }
  }

  async pause(): Promise<void> {
    throw new Error('ExoPlayer is only available on Android native')
  }

  async resume(): Promise<void> {
    throw new Error('ExoPlayer is only available on Android native')
  }

  async stop(): Promise<void> {
    throw new Error('ExoPlayer is only available on Android native')
  }

  async openMiracast(): Promise<{ connected: boolean; device?: string; peers?: string[] }> {
    throw new Error('ExoPlayer is only available on Android native')
  }

  async openDlna(_options: { url: string; title?: string }): Promise<{ sent: boolean; device?: string; reason?: string }> {
    throw new Error('ExoPlayer is only available on Android native')
  }

  async seekTo(_options: SeekOptions): Promise<void> {
    throw new Error('ExoPlayer is only available on Android native')
  }

  async setPlaybackRate(_options: RateOptions): Promise<void> {
    throw new Error('ExoPlayer is only available on Android native')
  }

  async playPip(_options: PlayPipOptions): Promise<{ status: string }> {
    throw new Error('ExoPlayer is only available on Android native')
  }

  async stopPip(): Promise<void> {}

  async isPipActive(): Promise<{ active: boolean }> {
    return { active: false }
  }
}
