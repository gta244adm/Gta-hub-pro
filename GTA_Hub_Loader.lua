-- GTA HUB — LOADER
-- Cola isso no executor. Ele baixa o GTA_Hub_Obfuscado.lua do teu repo (raw do
-- GitHub) e roda. Troca a URL abaixo pelo raw link real depois de subir o
-- arquivo obfuscado pro teu repo gta244adm/Gta-hub-pro.
--
-- Isso NAO e um loadstring de terceiro: e o proprio GTA Hub, so que hospedado
-- fora pra nao precisar colar o arquivo gigante toda vez.

local GTA_HUB_URL = "https://raw.githubusercontent.com/gta244adm/Gta-hub-pro/refs/heads/main/GTA_Hub_Admin_Reestruturado_20_ofuscado.txt"

local function GTA_LoadHub()
    local ok, body = pcall(function()
        return game:HttpGet(GTA_HUB_URL .. "?t=" .. tostring(math.floor(os.clock() * 1000)))
    end)

    if not ok or type(body) ~= "string" or body == "" then
        -- fallback pra executores sem HttpGet "oficial" (alguns usam request/http_request/syn.request)
        local req = request or http_request or (syn and syn.request)
        if req then
            local ok2, res = pcall(req, { Url = GTA_HUB_URL, Method = "GET" })
            if ok2 and res and res.Body then
                body = res.Body
            end
        end
    end

    if type(body) ~= "string" or body == "" then
        warn("[GTA HUB] Falha ao baixar o hub. Confere a URL/raw link e a conexao.")
        return
    end

    local chunk, err = loadstring(body)
    if not chunk then
        warn("[GTA HUB] Falha ao compilar o hub baixado: " .. tostring(err))
        return
    end

    local ok3, runErr = pcall(chunk)
    if not ok3 then
        warn("[GTA HUB] Erro ao executar o hub: " .. tostring(runErr))
    end
end

GTA_LoadHub()
