import type { ResolveOptions, ResolveResult, SearchOptions, SearchMoreOptions, SearchResult, SuggestOptions, SuggestResult, GetChannelOptions, ChannelInfoLite } from './definitions'

export class YoutubeWeb {
  async resolve(_options: ResolveOptions): Promise<ResolveResult> {
    throw new Error('YouTube extraction is only available on Android (NewPipeExtractor)')
  }

  async search(_options: SearchOptions): Promise<SearchResult> {
    throw new Error('YouTube search is only available on Android (NewPipeExtractor)')
  }

  async searchMore(_options: SearchMoreOptions): Promise<SearchResult> {
    throw new Error('YouTube search is only available on Android (NewPipeExtractor)')
  }

  async suggest(_options: SuggestOptions): Promise<SuggestResult> {
    throw new Error('YouTube suggestions are only available on Android (NewPipeExtractor)')
  }

  async getChannelInfo(_options: GetChannelOptions): Promise<ChannelInfoLite> {
    throw new Error('YouTube channel info is only available on Android (NewPipeExtractor)')
  }
}
