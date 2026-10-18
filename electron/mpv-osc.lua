-- octo-osc.lua — controles del reproductor embebido, estilo ExoPlayer Android.
--
-- mpv corre con --wid (incrustado en la ventana de la app) con
-- input-default-bindings=no: los eventos llegan por DOS vías posibles — si la
-- ventana hija selecciona input, entran nativamente; si no, propagan al DOM
-- y el renderer los reenvía como `mouse x y` / `keypress ...`.
--
-- Acciones internas (pause/seek/volume/speed/aspect/sub-delay) se ejecutan en
-- mpv; las de app (cerrar, zapping, subtítulos OpenSubtitles, canales,
-- episodios, cast, fullscreen) cruzan al renderer con
-- `script-message octo-action <accion> [args]` → evento {state:'osc'}.
-- El renderer empuja estado con `script-message-to octo_osc state|menu <json>`
-- (mpv deriva el nombre interno del archivo: octo-osc.lua → octo_osc).

local utils = require 'mp.utils'
local ov = mp.create_osd_overlay('ass-events')

local state = {
  title = '', live = false, chan = '',
  epgNow = '', epgNext = '', epgStart = 0, epgEnd = 0,
  canZap = false, hasImdb = false, hasEps = false, hasNext = false,
}
local menu = nil        -- {title, items={...}, action}
local visible = false
local showUntil = 0
local mx, my = -1, -1
local buttons = {}      -- hitboxes del último render
local seeking = false   -- ratón sobre la seekbar (hover)
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
  volMute  = 'm 4 12 l 10 12 l 17 5 l 17 27 l 10 20 l 4 20 b m 21 12 l 27 20 m 27 12 l 21 20',
  boost    = 'm 4 12 l 10 12 l 17 5 l 17 27 l 10 20 l 4 20 b m 20 11 c 24 13 24 19 20 21 b m 23 8 c 29 12 29 20 23 24',
  channels = 'm 12 8 l 28 8 b m 12 16 l 28 16 b m 12 24 l 28 24 b m 4 8 l 7 8 b m 4 16 l 7 16 b m 4 24 l 7 24',
  episodes = 'm 8 8 l 28 8 l 28 12 l 8 12 b m 8 14 l 28 14 l 28 18 l 8 18 b m 8 20 l 28 20 l 28 24 l 8 24',
  nextep   = 'm 6 6 l 20 16 l 6 26 b m 24 6 l 26 6 l 26 26 l 24 26',
  cast     = 'm 4 8 l 28 8 l 28 22 l 18 22 b m 4 26 c 9 26 13 22 13 17 b m 4 26 l 4 22',
  fullscr  = 'm 5 5 l 12 5 m 5 5 l 5 12 b m 27 5 l 20 5 m 27 5 l 27 12 b m 5 27 l 12 27 m 5 27 l 5 20 b m 27 27 l 20 27 m 27 27 l 27 20',
  subs     = 'm 4 6 l 28 6 l 28 26 l 4 26 b m 8 17 c 8 14 10 12 13 12 m 13 20 c 11 20 8 19 8 17 b m 20 17 c 20 14 22 12 25 12 m 25 20 c 23 20 20 19 20 17',
}

local icon_cmds = {
  play    = { 'cycle', 'pause' },
  pause   = { 'cycle', 'pause' },
  rew     = { 'seek', '-10', 'relative' },
  ffwd    = { 'seek', '10', 'relative' },
  zapPrev = { 'script-message', 'octo-zap', '-1' },
  zapNext = { 'script-message', 'octo-zap', '1' },
  vol     = { 'cycle', 'mute' },
  volMute = { 'cycle', 'mute' },
  boost   = { 'cycle-values', 'volume-max', '100', '150', '200' },
  channels= { 'script-message', 'octo-action', 'channels' },
  episodes= { 'script-message', 'octo-action', 'episodes' },
  nextep  = { 'script-message', 'octo-action', 'next-ep' },
  cast    = { 'script-message', 'octo-action', 'cast' },
  fullscr = { 'script-message', 'octo-action', 'fullscreen' },
  subs    = { 'script-message', 'octo-action', 'subs' },
}

local function send_action(a, arg)
  if arg ~= nil then
    mp.commandv('script-message', 'octo-action', tostring(a), tostring(arg))
  else
    mp.commandv('script-message', 'octo-action', tostring(a))
  end
end

-- ── Construcción del overlay ASS ────────────────────────────────────────────
local function render()
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

  -- Degradado superior (barra de título)
  rect(0, 0, w, 76 * s, ass_color('000000'), '70')
  icon('back', 14 * s, 14 * s, 30 * s, mx >= 6 * s and mx <= 60 * s and my >= 6 * s and my <= 62 * s)
  hit('back', 4 * s, 4 * s, 62 * s, 62 * s)
  text(64 * s, 18 * s, 26 * s, state.title ~= '' and state.title or mp.get_property('media-title') or '', 7, true)

  -- Degradado inferior (panel de controles)
  local panelH = (state.live and 128 or 116) * s
  rect(0, h - panelH, w, h, ass_color('000000'), '70')

  local cy = h - 44 * s -- centro vertical de la fila de botones
  local bs = 40 * s     -- tamaño de botón
  local gap = 10 * s

  -- Fila EPG / tiempos
  if state.live then
    local line = state.chan
    if state.epgNow ~= '' then line = line .. '  ·  ' .. state.epgNow end
    text(24 * s, h - panelH + 10 * s, 21 * s, line, 7, true)
    if state.epgNext ~= '' then
      text(24 * s, h - panelH + 38 * s, 17 * s, 'A continuación: ' .. state.epgNext, 7, false, C_DIM)
    end
    text(w - 24 * s, h - panelH + 10 * s, 18 * s, 'EN DIRECTO', 9, true, C_RED)
    -- Barra de progreso del programa EPG
    local barY = h - panelH + 66 * s
    local bx0, bx1 = 90 * s, w - 90 * s
    rect(bx0, barY, bx1, barY + 5 * s, ass_color('FFFFFF'), 'D0')
    local f = 0
    if state.epgEnd > state.epgStart then
      f = math.min(1, math.max(0, (os.time() - state.epgStart) / (state.epgEnd - state.epgStart)))
    end
    rect(bx0, barY, bx0 + (bx1 - bx0) * f, barY + 5 * s, C_PRIMARY, '00')
    text(bx0 - 8 * s, barY - 3 * s, 15 * s, fmt_clock(state.epgStart), 10, false, C_DIM)
    text(bx1 + 8 * s, barY - 3 * s, 15 * s, fmt_clock(state.epgEnd), 8, false, C_DIM)
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
    seeking = over({ x0 = bx0, y0 = barY - 8 * s, x1 = bx1, y1 = barY + 14 * s })
    text(bx0 - 8 * s, barY - 5 * s, 16 * s, fmt_time(pos), 10, false, C_WHITE)
    text(bx1 + 8 * s, barY - 5 * s, 16 * s, fmt_time(dur), 8, false, C_DIM)
    if seeking and dur > 0 then
      local t = math.min(1, math.max(0, (mx - bx0) / (bx1 - bx0))) * dur
      text(mx, barY - 30 * s, 15 * s, fmt_time(t), 5, true)
    end
  end

  -- Fila de botones (misma ordenación que Android: lista | rew play ffwd | stop ‖ vol boost CC CC± speed fit cast fs)
  local ids = {}
  if state.live and state.canZap then ids[#ids + 1] = 'channels' end
  if (not state.live) and state.hasEps then ids[#ids + 1] = 'episodes' end
  if state.live then ids[#ids + 1] = 'zapPrev' else ids[#ids + 1] = 'rew' end
  ids[#ids + 1] = (mp.get_property_native('pause') and 'play' or 'pause')
  if state.live then ids[#ids + 1] = 'zapNext' else ids[#ids + 1] = 'ffwd' end
  ids[#ids + 1] = 'stop'
  ids[#ids + 1] = '|'
  ids[#ids + 1] = mp.get_property_native('mute') and 'volMute' or 'vol'
  if not state.live then ids[#ids + 1] = 'boost' end
  if state.hasImdb or not state.live then ids[#ids + 1] = 'subs' end
  if state.hasNext then ids[#ids + 1] = 'nextep' end
  ids[#ids + 1] = '|'
  ids[#ids + 1] = 'cast'
  ids[#ids + 1] = 'fullscr'

  local total = 0
  for _, id in ipairs(ids) do total = total + (id == '|' and gap or bs + gap) end
  total = total - gap
  local x = (w - total) / 2
  for _, id in ipairs(ids) do
    if id == '|' then
      x = x + gap
    else
      local hovered = mx >= x and mx <= x + bs and my >= cy - bs / 2 and my <= cy + bs / 2
      icon(id, x, cy - bs / 2 + (bs - 32 * s) / 2, bs, hovered)
      hit(id, x, cy - bs / 2, x + bs, cy + bs / 2)
      x = x + bs + gap
    end
  end

  -- Botones de texto: CC± (delay subs), velocidad, Fit — a la derecha
  local tx = w - 24 * s
  local paused = mp.get_property_native('pause')
  local spd = mp.get_property_number('speed') or 1
  local subd = mp.get_property_number('sub-delay') or 0
  if not state.live then
    tx = tx - 52 * s
    text(tx, cy - 14 * s, 18 * s, string.format('%gx', spd), 5, true, over({ x0 = tx - 26 * s, y0 = cy - 20 * s, x1 = tx + 26 * s, y1 = cy + 20 * s }) and C_PRIMARY or C_WHITE)
    hit('speed', tx - 26 * s, cy - 20 * s, tx + 26 * s, cy + 20 * s)
    tx = tx - 56 * s
    local d = string.format('%+.1fs', subd)
    text(tx, cy - 14 * s, 16 * s, 'CC' .. d, 5, true, over({ x0 = tx - 30 * s, y0 = cy - 20 * s, x1 = tx + 30 * s, y1 = cy + 20 * s }) and C_PRIMARY or C_WHITE)
    hit('subdelay+', tx - 30 * s, cy - 20 * s, tx, cy + 20 * s)
    hit('subdelay-', tx, cy - 20 * s, tx + 30 * s, cy + 20 * s)
  end

  -- Menú (subtítulos / canales / episodios)
  if menu then
    local mw = 420 * s
    local mh = math.min(#menu.items, 14) * 34 * s + 46 * s
    local mx0 = w - mw - 24 * s
    local my0 = h - panelH - mh - 12 * s
    if my0 < 80 * s then my0 = 80 * s end
    rect(mx0, my0, mx0 + mw, my0 + mh, ass_color('14141F'), '10')
    text(mx0 + 16 * s, my0 + 10 * s, 17 * s, menu.title, 7, true, C_PRIMARY)
    for i, it in ipairs(menu.items) do
      if i > 14 then break end
      local iy = my0 + 40 * s + (i - 1) * 34 * s
      local hov = mx >= mx0 and mx <= mx0 + mw and my >= iy and my <= iy + 30 * s
      if hov then rect(mx0, iy - 2 * s, mx0 + mw, iy + 30 * s, ass_color('7B5BF5'), 'C0') end
      text(mx0 + 16 * s, iy, 15 * s, it, 7, false)
      hit('menu:' .. i, mx0, iy - 2 * s, mx0 + mw, iy + 30 * s)
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
  render()
end

-- ── Clicks ──────────────────────────────────────────────────────────────────
local function click()
  local now = mp.get_time()
  -- Refrescar posición al instante: el timer de 0.1s puede no haber corrido
  -- entre el `mouse x y` reenviado por el renderer y este keypress.
  mx, my = mp.get_mouse_pos()
  if now - lastDown < 0.05 then return end
  lastDown = now
  showUntil = now + 3
  if menu then
    for _, b in ipairs(buttons) do
      if b.id:sub(1, 5) == 'menu:' and mx >= b.x0 and mx <= b.x1 and my >= b.y0 and my <= b.y1 then
        local idx = tonumber(b.id:sub(6))
        local act = menu.action
        menu = nil
        render()
        send_action(act, idx)
        return
      end
    end
    menu = nil -- click fuera: cerrar menú
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
        mp.commandv('cycle-values', 'speed', '0.5', '1', '1.25', '1.5', '2')
      elseif b.id == 'subdelay+' then
        mp.commandv('add', 'sub-delay', -0.1)
      elseif b.id == 'subdelay-' then
        mp.commandv('add', 'sub-delay', 0.1)
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
  mp.commandv('add', 'volume', 3); show()
end)
mp.add_forced_key_binding('WHEEL_DOWN', 'octo-vol-down', function()
  mp.commandv('add', 'volume', -3); show()
end)
-- Teclado: embebido la ventana hija de mpv PUEDE recibir foco (el DOM no ve
-- esas teclas) — los comandos estándar se binden aquí además de en la app.
mp.add_forced_key_binding('SPACE', 'octo-space', function()
  mp.commandv('cycle', 'pause'); show()
end)
mp.add_forced_key_binding('LEFT', 'octo-left', function()
  mp.commandv('seek', '-10', 'relative'); show()
end)
mp.add_forced_key_binding('RIGHT', 'octo-right', function()
  mp.commandv('seek', '10', 'relative'); show()
end)
mp.add_forced_key_binding('UP', 'octo-up', function()
  mp.commandv('add', 'volume', 3); show()
end)
mp.add_forced_key_binding('DOWN', 'octo-down', function()
  mp.commandv('add', 'volume', -3); show()
end)
mp.add_forced_key_binding('m', 'octo-mute', function()
  mp.commandv('cycle', 'mute'); show()
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
    menu = obj
    show()
  end
end)

-- ── Auto-ocultado + seguimiento del ratón ───────────────────────────────────
mp.add_periodic_timer(0.1, function()
  local nx, ny = mp.get_mouse_pos()
  if nx ~= mx or ny ~= my then
    mx, my = nx, ny
    if not visible then show() else showUntil = mp.get_time() + 3; render() end
    return
  end
  if menu then return end
  if visible and mp.get_time() > showUntil and not mp.get_property_native('pause') then
    hide()
  end
end)

-- Cambios relevantes → repintar (hover de iconos, barra, delay…)
for _, p in ipairs({ 'pause', 'mute', 'speed', 'sub-delay', 'volume', 'sid' }) do
  mp.observe_property(p, 'native', function() if visible then render() end end)
end
mp.observe_property('time-pos', 'native', function() if visible and not menu then render() end end)

show()

-- Handshake con el proceso principal: los script-message-to enviados antes
-- de que el script exista se pierden ("Can't find script"). Esta marca se
-- observa por IPC (user-data/) y desbloquea la cola de estado/menús.
mp.set_property('user-data/octo-osc-ready', 'yes')
