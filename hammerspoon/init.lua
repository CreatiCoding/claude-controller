-- claude-controller: 매크로패드(하이퍼키+1~6) → 데몬 API
-- ※ 기본 경로는 Karabiner-Elements(karabiner/claude-controller.json)이며,
--    이 파일은 Hammerspoon을 선호하는 경우의 대체재다. 둘 중 하나만 쓰면 된다.
-- 매크로패드가 Ctrl+Alt+Shift+Win+숫자를 보내면 맥에서는 cmd+ctrl+alt+shift+숫자로 들어온다.
-- 사용법: 이 파일 내용을 ~/.hammerspoon/init.lua 에 추가(또는 require)하고 Hammerspoon 재시작.

local DAEMON = "http://127.0.0.1:9200"
local HYPER = { "cmd", "ctrl", "alt", "shift" }

local function sendKey(n)
  hs.http.asyncPost(
    DAEMON .. "/api/key",
    hs.json.encode({ key = n }),
    { ["Content-Type"] = "application/json" },
    function(status, body)
      if status ~= 200 then
        -- 대기 중인 허가 요청이 없는 등 무시해도 되는 경우: 짧게만 알림
        local msg = "claude-controller: 키 " .. n .. " 실패"
        if body and #body > 0 then
          local ok, parsed = pcall(hs.json.decode, body)
          if ok and parsed and parsed.error then msg = parsed.error end
        end
        hs.alert.show(msg, 1)
      end
    end
  )
end

for n = 1, 6 do
  hs.hotkey.bind(HYPER, tostring(n), function() sendKey(n) end)
end

hs.alert.show("claude-controller 키 바인딩 로드됨 (hyper+1~6)", 1.5)
