{
  "targets": [
    {
      "target_name": "vlc_player",
      "sources": ["addon.cc"],
      "include_dirs": [
        "/home/hola/optopus-stream/node_modules/node-addon-api",
        "/usr/include"
      ],
      "libraries": [
        "-lvlc"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc": ["-fexceptions", "-std=c++17"],
      "defines": ["NAPI_CPP_EXCEPTIONS", "NAPI_VERSION=8"]
    }
  ]
}
