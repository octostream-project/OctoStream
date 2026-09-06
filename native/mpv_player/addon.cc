#include <napi.h>
#include <mpv/client.h>
#include <mpv/render.h>
#include <mpv/render_gl.h>
#include <string>
#include <thread>
#include <atomic>
#include <map>

class MpvPlayer : public Napi::ObjectWrap<MpvPlayer> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "MpvPlayer", {
      InstanceMethod("load", &MpvPlayer::Load),
      InstanceMethod("play", &MpvPlayer::Play),
      InstanceMethod("pause", &MpvPlayer::Pause),
      InstanceMethod("stop", &MpvPlayer::Stop),
      InstanceMethod("seek", &MpvPlayer::Seek),
      InstanceMethod("setVolume", &MpvPlayer::SetVolume),
      InstanceMethod("setSpeed", &MpvPlayer::SetSpeed),
      InstanceMethod("getTime", &MpvPlayer::GetTime),
      InstanceMethod("getDuration", &MpvPlayer::GetDuration),
      InstanceMethod("setOption", &MpvPlayer::SetOption),
      InstanceMethod("setProperty", &MpvPlayer::SetProperty),
      InstanceMethod("getProperty", &MpvPlayer::GetProperty),
      InstanceMethod("destroy", &MpvPlayer::Destroy),
      InstanceMethod("observeProperties", &MpvPlayer::ObserveProperties),
    });

    Napi::FunctionReference* constructor = new Napi::FunctionReference();
    *constructor = Napi::Persistent(func);
    env.SetInstanceData(constructor);
    exports.Set("MpvPlayer", func);
    return exports;
  }

  MpvPlayer(const Napi::CallbackInfo& info) : Napi::ObjectWrap<MpvPlayer>(info) {
    mpv_ = mpv_create();
    if (!mpv_) {
      Napi::Error::New(info.Env(), "Failed to create mpv instance").ThrowAsJavaScriptException();
      return;
    }

    // Default options
    mpv_set_option_string(mpv_, "vo", "libmpv");
    mpv_set_option_string(mpv_, "vid", "no");
    mpv_set_option_string(mpv_, "terminal", "no");
    mpv_set_option_string(mpv_, "msg-level", "all=warn");
    mpv_set_option_string(mpv_, "hwdec", "auto-safe");
    mpv_set_option_string(mpv_, "keep-open", "yes");
    mpv_set_option_string(mpv_, "ytdl", "yes");

    if (mpv_initialize(mpv_) < 0) {
      Napi::Error::New(info.Env(), "Failed to initialize mpv").ThrowAsJavaScriptException();
      mpv_destroy(mpv_);
      mpv_ = nullptr;
      return;
    }

    running_ = true;
    eventThread_ = std::thread(&MpvPlayer::EventLoop, this);
  }

  ~MpvPlayer() {
    DestroyImpl();
  }

  Napi::Value Load(const Napi::CallbackInfo& info) {
    if (!mpv_) return info.Env().Undefined();
    std::string url = info[0].As<Napi::String>().Utf8Value();
    const char* cmd[] = {"loadfile", url.c_str(), nullptr};
    mpv_command(mpv_, cmd);
    return info.Env().Undefined();
  }

  Napi::Value Play(const Napi::CallbackInfo& info) {
    if (!mpv_) return info.Env().Undefined();
    int flag = 0;
    mpv_set_property(mpv_, "pause", MPV_FORMAT_FLAG, &flag);
    return info.Env().Undefined();
  }

  Napi::Value Pause(const Napi::CallbackInfo& info) {
    if (!mpv_) return info.Env().Undefined();
    int flag = 1;
    mpv_set_property(mpv_, "pause", MPV_FORMAT_FLAG, &flag);
    return info.Env().Undefined();
  }

  Napi::Value Stop(const Napi::CallbackInfo& info) {
    if (!mpv_) return info.Env().Undefined();
    const char* cmd[] = {"stop", nullptr};
    mpv_command(mpv_, cmd);
    return info.Env().Undefined();
  }

  Napi::Value Seek(const Napi::CallbackInfo& info) {
    if (!mpv_) return info.Env().Undefined();
    double target = info[0].As<Napi::Number>().DoubleValue();
    std::string mode = info.Length() > 1 ? info[1].As<Napi::String>().Utf8Value() : "absolute";
    const char* cmd[] = {"seek", std::to_string(target).c_str(), mode.c_str(), nullptr};
    mpv_command(mpv_, cmd);
    return info.Env().Undefined();
  }

  Napi::Value SetVolume(const Napi::CallbackInfo& info) {
    if (!mpv_) return info.Env().Undefined();
    double vol = info[0].As<Napi::Number>().DoubleValue();
    mpv_set_property(mpv_, "volume", MPV_FORMAT_DOUBLE, &vol);
    return info.Env().Undefined();
  }

  Napi::Value SetSpeed(const Napi::CallbackInfo& info) {
    if (!mpv_) return info.Env().Undefined();
    double speed = info[0].As<Napi::Number>().DoubleValue();
    mpv_set_property(mpv_, "speed", MPV_FORMAT_DOUBLE, &speed);
    return info.Env().Undefined();
  }

  Napi::Value GetTime(const Napi::CallbackInfo& info) {
    if (!mpv_) return Napi::Number::New(info.Env(), 0);
    double time = 0;
    mpv_get_property(mpv_, "time-pos", MPV_FORMAT_DOUBLE, &time);
    return Napi::Number::New(info.Env(), time);
  }

  Napi::Value GetDuration(const Napi::CallbackInfo& info) {
    if (!mpv_) return Napi::Number::New(info.Env(), 0);
    double dur = 0;
    mpv_get_property(mpv_, "duration", MPV_FORMAT_DOUBLE, &dur);
    return Napi::Number::New(info.Env(), dur);
  }

  Napi::Value SetOption(const Napi::CallbackInfo& info) {
    if (!mpv_) return info.Env().Undefined();
    std::string key = info[0].As<Napi::String>().Utf8Value();
    std::string val = info[1].As<Napi::String>().Utf8Value();
    mpv_set_option_string(mpv_, key.c_str(), val.c_str());
    return info.Env().Undefined();
  }

  Napi::Value SetProperty(const Napi::CallbackInfo& info) {
    if (!mpv_) return info.Env().Undefined();
    std::string key = info[0].As<Napi::String>().Utf8Value();
    std::string val = info[1].As<Napi::String>().Utf8Value();
    mpv_set_property_string(mpv_, key.c_str(), val.c_str());
    return info.Env().Undefined();
  }

  Napi::Value GetProperty(const Napi::CallbackInfo& info) {
    if (!mpv_) return info.Env().Undefined();
    std::string key = info[0].As<Napi::String>().Utf8Value();
    char* val = mpv_get_property_string(mpv_, key.c_str());
    if (!val) return info.Env().Undefined();
    Napi::String result = Napi::String::New(info.Env(), val);
    mpv_free(val);
    return result;
  }

  Napi::Value ObserveProperties(const Napi::CallbackInfo& info) {
    if (!mpv_) return info.Env().Undefined();
    Napi::Array props = info[0].As<Napi::Array>();
    for (uint32_t i = 0; i < props.Length(); i++) {
      std::string name = props.Get(i).As<Napi::String>().Utf8Value();
      mpv_observe_property(mpv_, i, name.c_str(), MPV_FORMAT_DOUBLE);
    }
    return info.Env().Undefined();
  }

  Napi::Value Destroy(const Napi::CallbackInfo& info) {
    DestroyImpl();
    return info.Env().Undefined();
  }

private:
  void DestroyImpl() {
    if (!mpv_) return;
    running_ = false;
    if (eventThread_.joinable()) eventThread_.join();
    mpv_terminate_destroy(mpv_);
    mpv_ = nullptr;
  }

  void EventLoop() {
    while (running_ && mpv_) {
      mpv_event* event = mpv_wait_event(mpv_, 0.1);
      if (event->event_id == MPV_EVENT_NONE) continue;
      // Events are handled via property observation
      if (event->event_id == MPV_EVENT_PROPERTY_CHANGE) {
        // Could emit to JS via thread-safe function
      }
      if (event->event_id == MPV_EVENT_SHUTDOWN) {
        running_ = false;
        break;
      }
    }
  }

  mpv_handle* mpv_ = nullptr;
  std::thread eventThread_;
  std::atomic<bool> running_{false};
};

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return MpvPlayer::Init(env, exports);
}

NODE_API_MODULE(mpv_player, InitAll)
