-- claude-controller: 매크로패드(F19~F24) → 데몬 API
-- ※ 기본 경로는 Karabiner-Elements(karabiner/claude-controller.json)이며,
--    이 파일은 Hammerspoon을 선호하는 경우의 대체재다. 둘 중 하나만 쓰면 된다.
-- 사용법: 이 파일 내용을 ~/.hammerspoon/init.lua 에 추가(또는 require)하고 Hammerspoon 재시작.

local DAEMON = "http://127.0.0.1:9200"

-- F19~F24 → 데몬 키 번호 1~6
local KEYMAP = { f19 = 1, f20 = 2, f21 = 3, f22 = 4, f23 = 5, f24 = 6 }

local function sendKey(n)
  hs.http.asyncPost(
    DAEMON .. "/api/key",
    hs.json.encode({ key = n }),
    { ["Content-Type"] = "application/json" },
    function(status, body)
      if status ~= 200 then
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

for key, n in pairs(KEYMAP) do
  hs.hotkey.bind({}, key, function() sendKey(n) end)
end

hs.alert.show("claude-controller 키 바인딩 로드됨 (F19~F24)", 1.5)
