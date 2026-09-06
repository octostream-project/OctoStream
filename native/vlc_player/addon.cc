#include <napi.h>
#include <vlc/vlc.h>
#include <string>
#include <thread>
#include <atomic>

class VlcPlayer : public Napi::ObjectWrap<VlcPlayer> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "VlcPlayer", {
      InstanceMethod("load", &VlcPlayer::Load),
      InstanceMethod("play", &VlcPlayer::Play),
      InstanceMethod("pause", &VlcPlayer::Pause),
      InstanceMethod("stop", &VlcPlayer::Stop),
      InstanceMethod("setVolume", &VlcPlayer::SetVolume),
      InstanceMethod("setSpeed", &VlcPlayer::SetSpeed),
      InstanceMethod("getTime", &VlcPlayer::GetTime),
      InstanceMethod("getDuration", &VlcPlayer::GetDuration),
      InstanceMethod("seek", &VlcPlayer::Seek),
      InstanceMethod("destroy", &VlcPlayer::Destroy),
    });

    exports.Set("VlcPlayer", func);
    return exports;
  }

  VlcPlayer(const Napi::CallbackInfo& info) : Napi::ObjectWrap<VlcPlayer>(info) {
    inst_ = libvlc_new(0, nullptr);
    if (!inst_) {
      Napi::Error::New(info.Env(), "Failed to create VLC instance").ThrowAsJavaScriptException();
      return;
    }
    media_ = nullptr;
    player_ = nullptr;
  }

  ~VlcPlayer() {
    DestroyImpl();
  }

  Napi::Value Load(const Napi::CallbackInfo& info) {
    if (!inst_) return info.Env().Undefined();
    std::string url = info[0].As<Napi::String>().Utf8Value();

    if (media_) libvlc_media_release(media_);
    if (player_) libvlc_media_player_release(player_);

    media_ = libvlc_media_new_location(inst_, url.c_str());
    if (!media_) return info.Env().Undefined();

    player_ = libvlc_media_player_new_from_media(media_);
    return info.Env().Undefined();
  }

  Napi::Value Play(const Napi::CallbackInfo& info) {
    if (player_) libvlc_media_player_play(player_);
    return info.Env().Undefined();
  }

  Napi::Value Pause(const Napi::CallbackInfo& info) {
    if (player_) libvlc_media_player_set_pause(player_, 1);
    return info.Env().Undefined();
  }

  Napi::Value Stop(const Napi::CallbackInfo& info) {
    if (player_) libvlc_media_player_stop(player_);
    return info.Env().Undefined();
  }

  Napi::Value SetVolume(const Napi::CallbackInfo& info) {
    if (!player_) return info.Env().Undefined();
    int vol = info[0].As<Napi::Number>().Int32Value();
    libvlc_audio_set_volume(player_, vol);
    return info.Env().Undefined();
  }

  Napi::Value SetSpeed(const Napi::CallbackInfo& info) {
    if (!player_) return info.Env().Undefined();
    float rate = info[0].As<Napi::Number>().FloatValue();
    libvlc_media_player_set_rate(player_, rate);
    return info.Env().Undefined();
  }

  Napi::Value GetTime(const Napi::CallbackInfo& info) {
    if (!player_) return Napi::Number::New(info.Env(), 0);
    libvlc_time_t t = libvlc_media_player_get_time(player_);
    return Napi::Number::New(info.Env(), (double)t / 1000.0);
  }

  Napi::Value GetDuration(const Napi::CallbackInfo& info) {
    if (!media_) return Napi::Number::New(info.Env(), 0);
    libvlc_time_t d = libvlc_media_get_duration(media_);
    return Napi::Number::New(info.Env(), (double)d / 1000.0);
  }

  Napi::Value Seek(const Napi::CallbackInfo& info) {
    if (!player_) return info.Env().Undefined();
    double secs = info[0].As<Napi::Number>().DoubleValue();
    libvlc_media_player_set_time(player_, (libvlc_time_t)(secs * 1000));
    return info.Env().Undefined();
  }

  Napi::Value Destroy(const Napi::CallbackInfo& info) {
    DestroyImpl();
    return info.Env().Undefined();
  }

private:
  void DestroyImpl() {
    if (player_) {
      libvlc_media_player_stop(player_);
      libvlc_media_player_release(player_);
      player_ = nullptr;
    }
    if (media_) {
      libvlc_media_release(media_);
      media_ = nullptr;
    }
    if (inst_) {
      libvlc_release(inst_);
      inst_ = nullptr;
    }
  }

  libvlc_instance_t* inst_ = nullptr;
  libvlc_media_t* media_ = nullptr;
  libvlc_media_player_t* player_ = nullptr;
};

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return VlcPlayer::Init(env, exports);
}

NODE_API_MODULE(vlc_player, InitAll)
