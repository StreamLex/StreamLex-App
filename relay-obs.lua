--[[
  Relay — OBS control script
  ==========================
  Adds native dropdowns inside OBS so you can change the TRANSLATED LANGUAGE and
  the OVERLAY STYLE without leaving OBS. It talks to the running Relay bridge.

  HOW TO USE
  ----------
  1) Start the Relay bridge as usual (start-relay.bat / node relay-bridge.js).
  2) In OBS:  Tools → Scripts → "+"  →  pick this file (relay-obs.lua).
  3) Use the dropdowns that appear. Changes apply to your overlay instantly.

  Prefer the FULL panel (all colours, fonts, etc.) inside OBS? Add
     http://localhost:4455/control?dock=1
  as a Custom Browser Dock (View → Docks → Custom Browser Docks). This script is
  the lightweight "native dropdown" alternative.

  Note: this posts to the bridge using `curl` (built into Windows 10+, macOS and
  Linux). On Windows a tiny console window may blink when a setting changes.
]]--

obs = obslua

local BRIDGE = "http://127.0.0.1:4455"
local started = false
local current = { lang="English", theme="clean", size="l", pos="bottom", plate=false }

-- Same theme presets as the Control window, expanded to the keys the overlay reads.
local THEMES = {
  clean    = {font="inter",    weight="800", caps="off", tracking="normal", align="center", anim="rise",  outw="med",   outcol="#000000", capcol="#ffffff", plate="off", chip="on"},
  bold     = {font="rounded",  weight="900", caps="on",  tracking="normal", align="center", anim="pop",   outw="thick", outcol="#000000", capcol="#ffffff", plate="off", chip="on"},
  subtitle = {font="system",   weight="700", caps="off", tracking="normal", align="center", anim="fade",  outw="thin",  outcol="#000000", capcol="#ffffff", plate="on", platecol="#000000", plateop="70", chip="off"},
  minimal  = {font="inter",    weight="600", caps="off", tracking="wide",   align="center", anim="fade",  outw="thin",  outcol="#000000", capcol="#ffffff", plate="off", chip="off"},
  neon     = {font="condensed",weight="700", caps="on",  tracking="wide",   align="center", anim="slide", outw="med",   outcol="#10002b", capcol="#aef6ff", hostcol="#ff4fd8", guestcol="#7cf6ff", plate="off", chip="on"},
}

local LANGS = {"English","Spanish","French","German","Italian","Portuguese","Dutch","Russian",
  "Japanese","Korean","Chinese (Simplified)","Arabic","Hindi","Polish","Turkish","Ukrainian",
  "Vietnamese","Indonesian","Swedish","Greek"}

local function json_escape(s) return (tostring(s):gsub("\\","\\\\"):gsub('"','\\"')) end
local function build_json(tbl)
  local parts = {}
  for k, v in pairs(tbl) do parts[#parts+1] = '"'..k..'":"'..json_escape(v)..'"' end
  return "{"..table.concat(parts, ",").."}"
end

-- Write the JSON to a temp file and let curl read it, so spaces/parentheses in
-- values (e.g. "Chinese (Simplified)") never get mangled by shell quoting.
local function post_config(tbl)
  local sep = package.config:sub(1, 1)
  local tmp = (os.getenv("TEMP") or os.getenv("TMP") or "/tmp") .. sep .. "relay_obs_cfg.json"
  local f = io.open(tmp, "w")
  if not f then return end
  f:write(build_json(tbl)); f:close()
  os.execute('curl -s -m 5 -X POST "'..BRIDGE..'/config" -H "Content-Type: application/json" --data-binary "@'..tmp..'"')
end

local function push()
  local cfg = {}
  local th = THEMES[current.theme]
  if th then for k, v in pairs(th) do cfg[k] = v end end
  if current.lang ~= "" then cfg.targetLang = current.lang end
  if current.size ~= "" then cfg.size = current.size end
  if current.pos  ~= "" then cfg.pos  = current.pos end
  cfg.plate = current.plate and "on" or "off"
  post_config(cfg)
end

function apply_button(props, prop)
  push()
  return false
end

function script_description()
  return [[<b>Relay — live translation control</b><br/>
Change the translated language and overlay style without leaving OBS.<br/><br/>
The Relay bridge must be running. For the full panel (colours, fonts, every
option), add <b>http://localhost:4455/control?dock=1</b> as a Custom Browser Dock.]]
end

function script_properties()
  local p = obs.obs_properties_create()
  obs.obs_properties_add_text(p, "bridge", "Bridge URL", obs.OBS_TEXT_DEFAULT)

  local lang = obs.obs_properties_add_list(p, "lang", "Translate to", obs.OBS_COMBO_TYPE_LIST, obs.OBS_COMBO_FORMAT_STRING)
  for _, l in ipairs(LANGS) do obs.obs_property_list_add_string(lang, l, l) end

  local theme = obs.obs_properties_add_list(p, "theme", "Theme", obs.OBS_COMBO_TYPE_LIST, obs.OBS_COMBO_FORMAT_STRING)
  for _, t in ipairs({"clean","bold","subtitle","minimal","neon"}) do obs.obs_property_list_add_string(theme, t, t) end

  local size = obs.obs_properties_add_list(p, "size", "Caption size", obs.OBS_COMBO_TYPE_LIST, obs.OBS_COMBO_FORMAT_STRING)
  obs.obs_property_list_add_string(size, "Small", "s")
  obs.obs_property_list_add_string(size, "Medium", "m")
  obs.obs_property_list_add_string(size, "Large", "l")
  obs.obs_property_list_add_string(size, "Extra large", "xl")

  local pos = obs.obs_properties_add_list(p, "pos", "Position", obs.OBS_COMBO_TYPE_LIST, obs.OBS_COMBO_FORMAT_STRING)
  obs.obs_property_list_add_string(pos, "Top", "top")
  obs.obs_property_list_add_string(pos, "Center", "center")
  obs.obs_property_list_add_string(pos, "Bottom", "bottom")

  obs.obs_properties_add_bool(p, "plate", "Dark plate behind text")
  obs.obs_properties_add_button(p, "apply", "Apply to overlay", apply_button)
  return p
end

function script_defaults(s)
  obs.obs_data_set_default_string(s, "bridge", "http://127.0.0.1:4455")
  obs.obs_data_set_default_string(s, "lang", "English")
  obs.obs_data_set_default_string(s, "theme", "clean")
  obs.obs_data_set_default_string(s, "size", "l")
  obs.obs_data_set_default_string(s, "pos", "bottom")
end

function script_update(s)
  local b = obs.obs_data_get_string(s, "bridge")
  BRIDGE = (b ~= "" and b) or "http://127.0.0.1:4455"
  current.lang  = obs.obs_data_get_string(s, "lang")
  current.theme = obs.obs_data_get_string(s, "theme")
  current.size  = obs.obs_data_get_string(s, "size")
  current.pos   = obs.obs_data_get_string(s, "pos")
  current.plate = obs.obs_data_get_bool(s, "plate")
  -- Skip the first call (script load) so we don't overwrite your current look;
  -- every later change applies live, and "Apply to overlay" forces it.
  if started then push() else started = true end
end
