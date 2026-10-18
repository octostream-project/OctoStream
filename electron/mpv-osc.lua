-- octo-osc.lua — controles del reproductor embebido, estilo ExoPlayer Android.
--
-- mpv corre con --wid (incrustado en la ventana de la app) con
-- input-default-bindings=no: los eventos llegan por DOS vías posibles — si la
-- ventana hija selecciona input, entran nativamente; si no, propagan al DOM
-- y el renderer los reenvía como `mouse x y` / `keypress ...`.
--
-- Acciones internas (pause/seek/volume/speed/aspect/pistas) se ejecutan en
-- mpv; las de app (cerrar, zapping, OpenSubtitles, canales, episodios, cast,
-- fullscreen, PiP) cruzan al renderer con
-- `script-message octo-action <accion> [args]` → evento {state:'osc'}.
-- El renderer empuja estado con `script-message-to octo_osc state|menu <json>`
-- (mpv deriva el nombre interno del archivo: octo-osc.lua → octo_osc).
--
-- Visibilidad por contenido (espejo de octo_controls.xml + ExoPlayerPlugin):
--   directo:  fila EPG + barra de programa, lista de canales, zap ▲/▼,
--             play/pause, stop, vol, subs, CC±, speed, Fit, ajustes, cast, PiP,
--             fullscreen — SIN rew/ffwd ni seekbar (Android los oculta).
--   VOD:      seekbar + tiempos, episodios (si hay), rew, play, ffwd, next-ep
--             (si hay), stop, vol, boost, subs, CC±, speed, Fit, ajustes,
--             cast, PiP, fullscreen.

local utils = require 'mp.utils'
local ov = mp.create_osd_overlay('ass-events')

local state = {
  title = '', live = false, chan = '',
  epgNow = '', epgNext = '', epgStart = 0, epgEnd = 0,
  canZap = false, hasImdb = false, hasEps = false, hasNext = false,
}
local menu = nil        -- {title, items={...}, action | internal=fn, scroll=0}
local popup = nil       -- 'vol' | 'boost' — slider emergente
local visible = false
local showUntil = 0
local mx, my = -1, -1
local buttons = {}      -- hitboxes del último render
local lastDown = 0      -- anti doble-click espurio

local PRIMARY = '7B5BF5'
local WHITE = 'FFFFFF'

local function ass_color(hex) return '&H' .. hex:sub(5, 6) .. hex:sub(3, 4) .. hex:sub(1, 2) .. '&' end
local C_PRIMARY = ass_color(PRIMARY)
local C_WHITE = ass_color(WHITE)
local C_DIM = ass_color('AAAAAA')
local C_RED = ass_color('FF4444')

local function esc(t)
  return tostring(t or ''):gsub('\\', '\\\\'):gsub('{', '\\{'):gsub('}', '\\}')
end

local function fmt_time(s)
  s = math.max(0, math.floor(tonumber(s) or 0))
  local h = math.floor(s / 3600)
  local m = math.floor((s % 3600) / 60)
  local sec = s % 60
  if h > 0 then return string.format('%d:%02d:%02d', h, m, sec) end
  return string.format('%d:%02d', m, sec)
end

local function fmt_clock(unix)
  unix = tonumber(unix) or 0
  if unix <= 0 then return '' end
  return os.date('%H:%M', unix)
end

-- ── Iconos vectoriales (assdraw) — sin depender de fuentes de símbolos ──────
local icons = {
  play     = 'm 5 3 l 27 16 l 5 29',
  pause    = 'm 7 4 l 13 4 l 13 28 l 7 28 b m 19 4 l 25 4 l 25 28 l 19 28',
  rew      = 'm 20 6 l 10 16 l 20 26 b m 32 6 l 22 16 l 32 26',
  ffwd     = 'm 12 6 l 22 16 l 12 26 b m 24 6 l 34 16 l 34 26',
  stop     = 'm 8 8 l 24 8 l 24 24 l 8 24',
  back     = 'm 24 6 l 10 16 l 24 26',
  zapPrev  = 'm 7 20 l 16 9 l 25 20',
  zapNext  = 'm 7 12 l 16 23 l 25 12',
  vol      = 'm 4 12 l 10 12 l 17 5 l 17 27 l 10 20 l 4 20 b m 20 11 c 24 13 24 19 20 21',
  -- ASS rellena cada subpath: las líneas abiertas salen invisibles y los
  -- contornos como blobs — todo icono es polígono relleno, los huecos van
  -- con winding inverso (anillos) y las "líneas" son rectángulos finos.
  volMute  = 'm 4 12 l 10 12 l 17 5 l 17 27 l 10 20 l 4 20 b m 20 11 l 22 9 l 30 17 l 28 19 b m 28 9 l 30 11 l 22 19 l 20 17 b',
  boost    = 'm 4 12 l 10 12 l 17 5 l 17 27 l 10 20 l 4 20 b m 20 11 c 24 13 24 19 20 21 l 19 19 c 22 18 22 14 19 13 b m 22 8 c 28 12 28 20 22 24 l 21 22 c 25 19 25 13 21 10 b',
  channels = 'm 12 7 l 28 7 l 28 9 l 12 9 b m 12 15 l 28 15 l 28 17 l 12 17 b m 12 23 l 28 23 l 28 25 l 12 25 b m 4 7 l 8 7 l 8 9 l 4 9 b m 4 15 l 8 15 l 8 17 l 4 17 b m 4 23 l 8 23 l 8 25 l 4 25 b',
  episodes = 'm 8 7 l 28 7 l 28 12 l 8 12 b m 8 14 l 28 14 l 28 19 l 8 19 b m 8 21 l 28 21 l 28 26 l 8 26 b',
  nextep   = 'm 6 6 l 20 16 l 6 26 b m 24 6 l 26 6 l 26 26 l 24 26',
  cast     = 'm 4 6 l 28 6 l 28 22 l 4 22 b m 6 8 l 6 20 l 26 20 l 26 8 b m 4 26 l 4 28 l 10 28 l 10 26 l 6 26 b',
  pip      = 'm 3 6 l 29 6 l 29 26 l 3 26 b m 5 8 l 5 24 l 27 24 l 27 8 b m 17 15 l 26 15 l 26 23 l 17 23 b',
  fullscr  = 'm 5 5 l 13 5 l 13 7 l 7 7 l 7 13 l 5 13 b m 19 5 l 27 5 l 27 13 l 25 13 l 25 7 l 19 7 b m 5 19 l 7 19 l 7 25 l 13 25 l 13 27 l 5 27 b m 25 19 l 27 19 l 27 27 l 19 27 l 19 25 l 25 25 b',
  subs     = 'm 4 6 l 28 6 l 28 26 l 4 26 b m 6 8 l 6 24 l 26 24 l 26 8 b m 8 16 c 8 12 10 10 14 10 l 14 12 c 12 12 10 13 10 16 c 10 19 12 20 14 20 l 14 22 c 10 22 8 20 8 16 b m 18 16 c 18 12 20 10 24 10 l 24 12 c 22 12 20 13 20 16 c 20 19 22 20 24 20 l 24 22 c 20 22 18 20 18 16 b',
  settings = 'm 16 9 c 20 9 23 12 23 16 c 23 20 20 23 16 23 c 12 23 9 20 9 16 c 9 12 12 9 16 9 b m 16 12 c 18 12 20 14 20 16 c 20 18 18 20 16 20 c 14 20 12 18 12 16 c 12 14 14 12 16 12 b m 15 3 l 17 3 l 17 8 l 15 8 b m 15 24 l 17 24 l 17 29 l 15 29 b m 3 15 l 8 15 l 8 17 l 3 17 b m 24 15 l 29 15 l 29 17 l 24 17 b',
}

local icon_cmds = {
  play    = { 'cycle', 'pause' },
  pause   = { 'cycle', 'pause' },
  rew     = { 'seek', '-10', 'relative' },
  ffwd    = { 'seek', '10', 'relative' },
  zapPrev = { 'script-message', 'octo-zap', '-1' },
  zapNext = { 'script-message', 'octo-zap', '1' },
  channels= { 'script-message', 'octo-action', 'channels' },
  episodes= { 'script-message', 'octo-action', 'episodes' },
  nextep  = { 'script-message', 'octo-action', 'next-ep' },
  cast    = { 'script-message', 'octo-action', 'cast' },
  pip     = { 'script-message', 'octo-action', 'pip' },
  fullscr = { 'script-message', 'octo-action', 'fullscreen' },
}

local function send_action(a, arg)
  if arg ~= nil then
    mp.commandv('script-message', 'octo-action', tostring(a), tostring(arg))
  else
    mp.commandv('script-message', 'octo-action', tostring(a))
  end
end

local render -- forward decl (los menús re-renderizan)

-- ── Pistas / menús internos (audio, subtítulos, velocidad, aspecto) ─────────
local function track_items(kind, current_prop)
  local items, ids = {}, {}
  for _, t in ipairs(mp.get_property_native('track-list') or {}) do
    if t.type == kind then
      local label = t.title or t.lang or ('Pista ' .. tostring(t.id))
      if t.lang and t.title then label = t.title .. ' [' .. t.lang .. ']' end
      items[#items + 1] = (t.selected and '• ' or '   ') .. label
      ids[#ids + 1] = t.id
    end
  end
  return items, ids
end

local function open_sub_menu()
  local items, ids = track_items('sub')
  table.insert(items, 1, (mp.get_property('sid') == 'no' and '• ' or '   ') .. 'Desactivados')
  table.insert(ids, 1, 'no')
  if state.hasImdb then
    items[#items + 1] = '   Buscar en OpenSubtitles…'
    ids[#ids + 1] = 'osd'
  end
  menu = { title = 'Subtítulos', items = items, scroll = 0, internal = function(idx)
    local id = ids[idx]
    menu = nil
    if id == 'osd' then send_action('subs')
    elseif id ~= nil then mp.set_property('sid', tostring(id)) end
    render()
  end }
end

local function open_audio_menu()
  local items, ids = track_items('audio')
  if #items == 0 then items = { 'Sin pistas de audio' } ids = {} end
  menu = { title = 'Pista de audio', items = items, scroll = 0, internal = function(idx)
    local id = ids[idx]
    menu = nil
    if id ~= nil then mp.set_property('aid', tostring(id)) end
    render()
  end }
end

local SPEEDS = { 0.5, 0.75, 1, 1.25, 1.5, 2 }
local function open_speed_menu()
  local cur = mp.get_property_number('speed') or 1
  local items = {}
  for _, v in ipairs(SPEEDS) do
    items[#items + 1] = (math.abs(cur - v) < 0.01 and '• ' or '   ') .. string.format('%gx', v)
  end
  menu = { title = 'Velocidad', items = items, scroll = 0, internal = function(idx)
    menu = nil
    mp.set_property('speed', tostring(SPEEDS[idx] or 1))
    render()
  end }
end

local ASPECTS = {
  { 'Automático (Fit)', '-1' },
  { '16:9', '16:9' },
  { '4:3', '4:3' },
  { 'Panorámica 2.35:1', '2.35:1' },
  { 'Rellenar', 'no' },
}
local function aspect_label()
  local a = mp.get_property('video-aspect-override') or '-1'
  if a == 'no' then return 'Fill' end
  local n = tonumber(a)
  if not n or n <= 0 then return 'Fit' end
  return a
end
local function open_aspect_menu()
  local cur = mp.get_property('video-aspect-override') or '-1'
  local curN = tonumber(cur)
  local items = {}
  for _, e in ipairs(ASPECTS) do
    local sel = (cur == e[2]) or (e[2] == '-1' and (not curN or curN <= 0))
    items[#items + 1] = (sel and '• ' or '   ') .. e[1]
  end
  menu = { title = 'Relación de aspecto', items = items, scroll = 0, internal = function(idx)
    menu = nil
    local e = ASPECTS[idx]
    if e then mp.set_property('video-aspect-override', e[2]) end
    render()
  end }
end

local function open_settings_menu()
  menu = { title = 'Ajustes', scroll = 0, items = {
      'Pista de audio', 'Subtítulos', 'Velocidad', 'Relación de aspecto',
    }, internal = function(idx)
    if idx == 1 then open_audio_menu()
    elseif idx == 2 then open_sub_menu()
    elseif idx == 3 then open_speed_menu()
    elseif idx == 4 then open_aspect_menu()
    end
    render()
  end }
end

-- ── Construcción del overlay ASS ────────────────────────────────────────────
render = function()
  local w, h = mp.get_osd_size()
  if not w or w == 0 then return end
  -- La resolución del overlay se fija al CREARLO con el tamaño de ventana de
  -- ese instante — con --wid mpv arranca a su default 1280x720 y el embed lo
  -- redimensiona después: sin esto, todo el dibujo queda escalado/desplazado
  -- (y≈700 caía en 747, los textos de borde derecho se cortaban).
  ov.res_x, ov.res_y = w, h
  local s = h / 720 -- escala base 720p
  local a = {}
  buttons = {}

  local function add(s2) a[#a + 1] = s2 end
  local function rect(x0, y0, x1, y1, color, alpha)
    add(string.format('{\\p1\\pos(0,0)\\1c%s\\1a&H%s&\\3a&HFF&\\4a&HFF&\\bord0\\shad0}m %d %d l %d %d l %d %d l %d %d{\\p0}',
      color, alpha or '00', x0, y0, x1, y0, x1, y1, x0, y1))
  end
  local function icon(name, x, y, size, hovered)
    local p = icons[name]
    if not p then return end
    local sc = (size or 32) * s / 32
    local col = hovered and C_PRIMARY or C_WHITE
    add(string.format('{\\p1\\pos(%d,%d)\\fscx%d\\fscy%d\\1c%s\\1a&H00&\\3a&HFF&\\4a&HFF&\\bord0\\shad0}%s{\\p0}',
      x, y, sc * 100, sc * 100, col, p))
  end
  local function text(x, y, size, str, anchor, bold, color, alpha)
    add(string.format('{\\pos(%d,%d)\\an%d\\fs%d\\1c%s\\1a&H%s&\\3a&HFF&\\4a&HFF&%s}%s',
      x, y, anchor or 7, size, color or C_WHITE, alpha or '00',
      bold and '\\b1' or '\\b0', esc(str)))
  end
  local function hit(id, x0, y0, x1, y1)
    buttons[#buttons + 1] = { id = id, x0 = x0, y0 = y0, x1 = x1, y1 = y1 }
  end
  local function over(b)
    return mx >= b.x0 and mx <= b.x1 and my >= b.y0 and my <= b.y1
  end

  if not visible and not menu then ov.data = ''; ov:update(); return end

  -- Degradado superior (barra de título + reloj como en Android)
  rect(0, 0, w, 76 * s, ass_color('000000'), '70')
  icon('back', 14 * s, 14 * s, 30 * s, mx >= 6 * s and mx <= 60 * s and my >= 6 * s and my <= 62 * s)
  hit('back', 4 * s, 4 * s, 62 * s, 62 * s)
  text(64 * s, 18 * s, 26 * s, state.title ~= '' and state.title or mp.get_property('media-title') or '', 7, true)
  text(w - 20 * s, 20 * s, 20 * s, os.date('%H:%M'), 9, false, C_DIM)

  -- Degradado inferior (panel de controles)
  local panelH = (state.live and 128 or 116) * s
  rect(0, h - panelH, w, h, ass_color('000000'), '70')

  local cy = h - 44 * s -- centro vertical de la fila de botones
  local bs = 40 * s     -- tamaño de botón
  local gap = 10 * s

  -- Fila EPG / tiempos (solo directo, como en Android)
  if state.live then
    local line = state.chan
    if state.epgNow ~= '' then line = line .. '  ·  ' .. state.epgNow end
    text(24 * s, h - panelH + 10 * s, 21 * s, line, 7, true)
    if state.epgNext ~= '' then
      text(24 * s, h - panelH + 38 * s, 17 * s, 'A continuación: ' .. state.epgNext, 7, false, C_DIM)
    end
    if state.epgNow ~= '' then
      text(w - 24 * s, h - panelH + 10 * s, 18 * s, 'EN DIRECTO', 9, true, C_RED)
    end
    -- Barra de progreso del programa EPG
    local barY = h - panelH + 66 * s
    local bx0, bx1 = 90 * s, w - 90 * s
    rect(bx0, barY, bx1, barY + 5 * s, ass_color('FFFFFF'), 'D0')
    local f = 0
    local es, ee = tonumber(state.epgStart) or 0, tonumber(state.epgEnd) or 0
    if ee > es then
      f = math.min(1, math.max(0, (os.time() - es) / (ee - es)))
    end
    rect(bx0, barY, bx0 + (bx1 - bx0) * f, barY + 5 * s, C_PRIMARY, '00')
    text(bx0 - 8 * s, barY - 3 * s, 15 * s, fmt_clock(es), 10, false, C_DIM)
    text(bx1 + 8 * s, barY - 3 * s, 15 * s, fmt_clock(ee), 8, false, C_DIM)
  else
    -- Seekbar VOD
    local pos = mp.get_property_number('time-pos') or 0
    local dur = mp.get_property_number('duration') or 0
    local barY = h - panelH + 14 * s
    local bx0, bx1 = 100 * s, w - 100 * s
    rect(bx0, barY, bx1, barY + 6 * s, ass_color('FFFFFF'), 'D0')
    local f = dur > 0 and math.min(1, pos / dur) or 0
    rect(bx0, barY, bx0 + (bx1 - bx0) * f, barY + 6 * s, C_PRIMARY, '00')
    -- puntero
    rect(bx0 + (bx1 - bx0) * f - 2 * s, barY - 3 * s, bx0 + (bx1 - bx0) * f + 2 * s, barY + 9 * s, C_PRIMARY, '00')
    hit('seekbar', bx0, barY - 8 * s, bx1, barY + 14 * s)
    local hovSeek = mx >= bx0 and mx <= bx1 and my >= barY - 8 * s and my <= barY + 14 * s
    text(bx0 - 8 * s, barY - 5 * s, 16 * s, fmt_time(pos), 10, false, C_WHITE)
    text(bx1 + 8 * s, barY - 5 * s, 16 * s, fmt_time(dur), 8, false, C_DIM)
    if hovSeek and dur > 0 then
      local t = math.min(1, math.max(0, (mx - bx0) / (bx1 - bx0))) * dur
      text(mx, barY - 30 * s, 15 * s, fmt_time(t), 5, true)
    end
  end

  -- Fila de botones — mismo orden que octo_controls.xml:
  -- live: canales | ▲ play ▼ | stop ‖ vol subs CC± speed Fit ajustes ‖ cast pip fs
  -- vod:  episodios? | rew play ffwd next? | stop ‖ vol boost subs CC± speed Fit ajustes ‖ cast pip fs
  local row = {}
  local function B(id) row[#row + 1] = { id = id, w = bs } end
  local function T(id, label, tw) row[#row + 1] = { id = id, text = label, w = (tw or 48) * s } end
  local function SEP() row[#row + 1] = { sep = true, w = gap } end
  local subd = mp.get_property_number('sub-delay') or 0
  local spd = mp.get_property_number('speed') or 1

  if state.live then
    B('channels'); B('zapPrev')
    B(mp.get_property_native('pause') and 'play' or 'pause')
    B('zapNext'); B('stop'); SEP()
    B(mp.get_property_native('mute') and 'volMute' or 'vol')
    B('boost'); B('subs')
    T('subdelay', string.format('CC%+.1f', subd), 54)
    T('speed', string.format('%gx', spd), 42)
    T('aspect', aspect_label(), 52)
    B('settings'); SEP()
    B('cast'); B('pip'); B('fullscr')
  else
    if state.hasEps then B('episodes') end
    B('rew')
    B(mp.get_property_native('pause') and 'play' or 'pause')
    B('ffwd')
    if state.hasNext then B('nextep') end
    B('stop'); SEP()
    B(mp.get_property_native('mute') and 'volMute' or 'vol')
    B('boost'); B('subs')
    T('subdelay', string.format('CC%+.1f', subd), 54)
    T('speed', string.format('%gx', spd), 42)
    T('aspect', aspect_label(), 52)
    B('settings'); SEP()
    B('cast'); B('pip'); B('fullscr')
  end

  -- Escalado defensivo si la fila no cabe (ventanas muy estrechas)
  local total = 0
  for _, it in ipairs(row) do total = total + it.w end
  total = total + gap * (#row - 1)
  local avail = w - 48 * s
  local rs = total > avail and (avail / total) or 1

  local x = (w - total * rs) / 2
  local volCx, boostCx = nil, nil
  for _, it in ipairs(row) do
    local iw = it.w * rs
    if it.sep then
      x = x + iw + gap * rs
    else
      local hovered = mx >= x and mx <= x + iw and my >= cy - bs / 2 and my <= cy + bs / 2
      if it.text then
        text(x + iw / 2, cy - 13 * s, 17 * s, it.text, 5, true, hovered and C_PRIMARY or C_WHITE)
      else
        icon(it.id, x + (iw - bs * rs) / 2, cy - bs * rs / 2 + (bs * rs - 32 * s * rs) / 2, bs * rs, hovered or (popup and ((popup == 'vol' and (it.id == 'vol' or it.id == 'volMute')) or (popup == 'boost' and it.id == 'boost'))))
        if it.id == 'vol' or it.id == 'volMute' then volCx = x + iw / 2 end
        if it.id == 'boost' then boostCx = x + iw / 2 end
      end
      hit(it.id, x, cy - bs / 2, x + iw, cy + bs / 2)
      x = x + iw + gap * rs
    end
  end

  -- Popup de volumen / amplificador (slider como en Android)
  if popup then
    local pw = 200 * s
    local pcx = popup == 'vol' and (volCx or w / 2) or (boostCx or w / 2)
    local px0 = math.max(12 * s, math.min(w - pw - 12 * s, pcx - pw / 2))
    local py = cy - 74 * s
    rect(px0 - 10 * s, py - 14 * s, px0 + pw + 10 * s, py + 26 * s, ass_color('14141F'), '08')
    local val, vmin, vmax
    if popup == 'vol' then
      vmin, vmax = 0, 100
      val = mp.get_property_number('volume') or 0
    else
      vmin, vmax = 100, 300
      val = mp.get_property_number('volume') or 0
    end
    local f = math.min(1, math.max(0, (val - vmin) / (vmax - vmin)))
    rect(px0, py, px0 + pw, py + 8 * s, ass_color('FFFFFF'), 'D0')
    rect(px0, py, px0 + pw * f, py + 8 * s, C_PRIMARY, '00')
    rect(px0 + pw * f - 3 * s, py - 4 * s, px0 + pw * f + 3 * s, py + 12 * s, C_PRIMARY, '00')
    text(px0 + pw / 2, py - 12 * s, 14 * s,
      (popup == 'boost' and '+' or '') .. string.format('%d%%', val), 5, true)
    hit('popup:' .. popup, px0 - 10 * s, py - 14 * s, px0 + pw + 10 * s, py + 26 * s)
  end

  -- Menú (subtítulos / canales / episodios / ajustes) — con scroll
  if menu then
    local mw = 420 * s
    local maxRows = 14
    local n = #menu.items
    menu.scroll = math.max(0, math.min(menu.scroll or 0, math.max(0, n - maxRows)))
    local mh = math.min(n, maxRows) * 34 * s + 46 * s
    local mx0 = w - mw - 24 * s
    local my0 = h - panelH - mh - 12 * s
    if my0 < 80 * s then my0 = 80 * s end
    rect(mx0, my0, mx0 + mw, my0 + mh, ass_color('14141F'), '10')
    text(mx0 + 16 * s, my0 + 10 * s, 17 * s, menu.title, 7, true, C_PRIMARY)
    local first = menu.scroll + 1
    local last = math.min(n, menu.scroll + maxRows)
    for i = first, last do
      local iy = my0 + 40 * s + (i - first) * 34 * s
      local hov = mx >= mx0 and mx <= mx0 + mw and my >= iy and my <= iy + 30 * s
      if hov then rect(mx0, iy - 2 * s, mx0 + mw, iy + 30 * s, ass_color('7B5BF5'), 'C0') end
      text(mx0 + 16 * s, iy, 15 * s, menu.items[i], 7, false)
      hit('menu:' .. i, mx0, iy - 2 * s, mx0 + mw, iy + 30 * s)
    end
    -- Indicador de scroll
    if n > maxRows then
      local th = (my0 + mh - my0 - 50 * s)
      local sh = math.max(20 * s, th * maxRows / n)
      local sy = my0 + 44 * s + (th - sh) * (menu.scroll / (n - maxRows))
      rect(mx0 + mw - 6 * s, sy, mx0 + mw - 2 * s, sy + sh, C_PRIMARY, '40')
    end
  end

  ov.data = table.concat(a, '\n')
  ov:update()
end

local function show()
  visible = true
  showUntil = mp.get_time() + 3
  render()
end

local function hide()
  visible = false
  menu = nil
  popup = nil
  render()
end

-- ── Clicks ──────────────────────────────────────────────────────────────────
local function click(nx, ny)
  local now = mp.get_time()
  -- Coordenadas: las del mensaje clickat si vienen (deterministas); si no,
  -- get_mouse_pos directo (clicks nativos en la ventana hija).
  if nx and ny then mx, my = nx, ny
  else mx, my = mp.get_mouse_pos() end
  if now - lastDown < 0.05 then return end
  lastDown = now
  showUntil = now + 3
  if menu then
    for _, b in ipairs(buttons) do
      if b.id:sub(1, 5) == 'menu:' and mx >= b.x0 and mx <= b.x1 and my >= b.y0 and my <= b.y1 then
        local idx = tonumber(b.id:sub(6))
        if menu.internal then
          menu.internal(idx) -- el handler decide si cierra o abre submenú
        else
          local act = menu.action
          menu = nil
          render()
          send_action(act, idx)
        end
        return
      end
    end
    menu = nil -- click fuera: cerrar menú
    render()
    return
  end
  -- Popup abierto: click en el slider ajusta, fuera lo cierra
  if popup then
    for _, b in ipairs(buttons) do
      if b.id == 'popup:' .. popup and mx >= b.x0 and mx <= b.x1 and my >= b.y0 and my <= b.y1 then
        -- fracción sobre la barra interior (margen 10 a cada lado)
        local inner = b.x1 - b.x0 - 20
        local f = math.min(1, math.max(0, (mx - b.x0 - 10) / math.max(1, inner)))
        if popup == 'vol' then
          mp.commandv('set', 'volume', tostring(math.floor(f * 100 + 0.5)))
        else
          mp.commandv('set', 'volume-max', '300')
          mp.commandv('set', 'volume', tostring(math.floor(100 + f * 200 + 0.5)))
        end
        showUntil = now + 3
        render()
        return
      end
    end
    popup = nil
    render()
    return
  end
  if not visible then show(); return end
  for _, b in ipairs(buttons) do
    if mx >= b.x0 and mx <= b.x1 and my >= b.y0 and my <= b.y1 then
      if b.id == 'seekbar' then
        local dur = mp.get_property_number('duration') or 0
        if dur > 0 then
          local t = math.min(1, math.max(0, (mx - b.x0) / (b.x1 - b.x0))) * dur
          mp.commandv('seek', t, 'absolute')
        end
      elseif b.id == 'speed' then
        mp.commandv('cycle-values', 'speed', '0.5', '0.75', '1', '1.25', '1.5', '2')
      elseif b.id == 'aspect' then
        mp.commandv('cycle-values', 'video-aspect-override', '-1', '16:9', '4:3', '2.35:1', 'no')
      elseif b.id == 'subdelay' then
        -- mitad izquierda = -0.1s, mitad derecha = +0.1s (botón CC± de Android)
        mp.commandv('add', 'sub-delay', tostring(mx < (b.x0 + b.x1) / 2 and -0.1 or 0.1))
      elseif b.id == 'subs' then
        open_sub_menu(); show()
        return
      elseif b.id == 'settings' then
        open_settings_menu(); show()
        return
      elseif b.id == 'vol' or b.id == 'volMute' then
        popup = 'vol'; show()
        return
      elseif b.id == 'boost' then
        mp.commandv('set', 'volume-max', '300')
        popup = 'boost'; show()
        return
      elseif b.id == 'back' or b.id == 'stop' then
        send_action('close')
      else
        local cmd = icon_cmds[b.id]
        if cmd then mp.commandv(unpack(cmd)) end
      end
      show()
      return
    end
  end
  -- Click fuera: ocultar controles
  hide()
end

-- ── Input ───────────────────────────────────────────────────────────────────
mp.add_forced_key_binding('MOUSE_BTN0', 'octo-click', click)
mp.add_forced_key_binding('MOUSE_BTN2', 'octo-rclick', function()
  if menu then menu = nil; render() else mp.commandv('cycle', 'pause') end
end)
mp.add_forced_key_binding('WHEEL_UP', 'octo-vol-up', function()
  if menu then
    menu.scroll = math.max(0, (menu.scroll or 0) - 1)
    render()
  else
    mp.commandv('add', 'volume', 3); show()
  end
end)
mp.add_forced_key_binding('WHEEL_DOWN', 'octo-vol-down', function()
  if menu then
    menu.scroll = math.min(math.max(0, #menu.items - 14), (menu.scroll or 0) + 1)
    render()
  else
    mp.commandv('add', 'volume', -3); show()
  end
end)
-- Teclado: embebido la ventana hija de mpv PUEDE recibir foco (el DOM no ve
-- esas teclas) — los comandos estándar se binden aquí además de en la app.
mp.add_forced_key_binding('SPACE', 'octo-space', function()
  mp.commandv('cycle', 'pause'); show()
end)
mp.add_forced_key_binding('LEFT', 'octo-left', function()
  if menu then menu.scroll = math.max(0, (menu.scroll or 0) - 1); render(); return end
  mp.commandv('seek', '-10', 'relative'); show()
end)
mp.add_forced_key_binding('RIGHT', 'octo-right', function()
  if menu then menu.scroll = math.min(math.max(0, #menu.items - 14), (menu.scroll or 0) + 1); render(); return end
  mp.commandv('seek', '10', 'relative'); show()
end)
mp.add_forced_key_binding('UP', 'octo-up', function()
  if menu then menu.scroll = math.max(0, (menu.scroll or 0) - 1); render(); return end
  mp.commandv('add', 'volume', 3); show()
end)
mp.add_forced_key_binding('DOWN', 'octo-down', function()
  if menu then menu.scroll = math.min(math.max(0, #menu.items - 14), (menu.scroll or 0) + 1); render(); return end
  mp.commandv('add', 'volume', -3); show()
end)
mp.add_forced_key_binding('m', 'octo-mute', function()
  mp.commandv('cycle', 'mute'); show()
end)
mp.add_forced_key_binding('PGUP', 'octo-pgup', function()
  mp.commandv('script-message', 'octo-zap', '-1')
end)
mp.add_forced_key_binding('PGDWN', 'octo-pgdn', function()
  mp.commandv('script-message', 'octo-zap', '1')
end)
mp.add_forced_key_binding('c', 'octo-subs-key', function()
  if menu then menu = nil; render(); return end
  open_sub_menu(); show()
end)
mp.add_forced_key_binding('f', 'octo-fs-key', function()
  send_action('fullscreen')
end)

-- ── Estado empujado desde el renderer ───────────────────────────────────────
mp.register_script_message('state', function(json)
  local ok, obj = pcall(utils.parse_json, json)
  if ok and type(obj) == 'table' then
    for k, v in pairs(obj) do state[k] = v end
    render()
  end
end)

mp.register_script_message('menu', function(json)
  local ok, obj = pcall(utils.parse_json, json)
  if ok and type(obj) == 'table' and obj.items then
    obj.scroll = 0
    menu = obj
    show()
  end
end)

-- Clicks del DOM con coordenadas en el mismo mensaje: `mouse x y` seguido
-- de `keypress` se evaluaba a veces con la posición del evento anterior.
mp.register_script_message('clickat', function(json)
  local ok, obj = pcall(utils.parse_json, json)
  local nx, ny
  if ok and type(obj) == 'table' then nx, ny = tonumber(obj.x), tonumber(obj.y) end
  click(nx, ny)
end)

-- ── Auto-ocultado + seguimiento del ratón ───────────────────────────────────
mp.add_periodic_timer(0.1, function()
  local nx, ny = mp.get_mouse_pos()
  if nx ~= mx or ny ~= my then
    mx, my = nx, ny
    if not visible then show() else showUntil = mp.get_time() + 3; render() end
    return
  end
  if menu or popup then return end
  if visible and mp.get_time() > showUntil and not mp.get_property_native('pause') then
    hide()
  end
end)

-- Cambios relevantes → repintar (hover de iconos, barra, delay…)
for _, p in ipairs({ 'pause', 'mute', 'speed', 'sub-delay', 'volume', 'volume-max', 'sid', 'aid', 'video-aspect-override' }) do
  mp.observe_property(p, 'native', function() if visible then render() end end)
end
mp.observe_property('time-pos', 'native', function() if visible and not menu then render() end end)

show()

-- Handshake con el proceso principal: los script-message-to enviados antes
-- de que el script exista se pierden ("Can't find script"). Esta marca se
-- observa por IPC (user-data/) y desbloquea la cola de estado/menús.
mp.set_property('user-data/octo-osc-ready', 'yes')
