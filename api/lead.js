// api/lead.js
// Vercel Serverless: cria Contact + Lead no Kommo
// ENV VARS na Vercel:
// - KOMMO_SUBDOMAIN = mrltravel
// - KOMMO_TOKEN = <seu access token (sem "Bearer")>

function onlyDigits(v = "") {
  return String(v).replace(/\D/g, "");
}

function normalizePhoneBR(v = "") {
  // Aceita (37) 99999-9999, 37999999999, etc
  // Retorna sempre com DDI 55 + DDD + número (13 dígitos no total com 55)
  const d = onlyDigits(v).slice(0, 13); // caso já venha com 55
  if (!d) return "";

  // Se já começou com 55 e tem 12-13 dígitos, mantém
  if (d.startsWith("55")) {
    return d.slice(0, 13);
  }

  // Se veio só DDD+número (10/11 dígitos), prefixa 55
  const local = d.slice(0, 11);
  return "55" + local;
}

function safeTrim(v = "") {
  return String(v).trim();
}

function getKommoBaseUrl() {
  const subdomain = process.env.KOMMO_SUBDOMAIN;
  if (!subdomain) throw new Error("Env KOMMO_SUBDOMAIN não definida.");
  return `https://${subdomain}.kommo.com`;
}

function getKommoToken() {
  const token = process.env.KOMMO_TOKEN;
  if (!token) throw new Error("Env KOMMO_TOKEN não definida.");
  return token.trim();
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;

  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Body inválido. Envie JSON válido."));
      }
    });
    req.on("error", reject);
  });
}

async function kommoFetch(url, token, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!resp.ok) {
    const msg =
      json?.title || json?.message || json?.detail || resp.statusText || "Erro Kommo";
    const err = new Error(`${msg} (HTTP ${resp.status})`);
    err.status = resp.status;
    err.payload = json;
    throw err;
  }

  return json;
}

async function createContact({ nome, telefone }, { baseUrl, token }) {
  const phoneValue = telefone ? String(telefone) : "";

  const body = [
    {
      name: nome,
      ...(phoneValue
        ? {
            custom_fields_values: [
              {
                field_id: 1024825, // ID Telefone que você passou
                values: [
                  {
                    value: phoneValue, // EX: "5537999678786"
                    enum_code: "WORK", // pode manter WORK (ou PERSONAL). Se não funcionar, eu te mostro o ajuste.
                  },
                ],
              },
            ],
          }
        : {}),
    },
  ];

  const json = await kommoFetch(`${baseUrl}/api/v4/contacts`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });

  const contactId = json?._embedded?.contacts?.[0]?.id;
  if (!contactId) throw new Error("Não consegui obter o ID do contato criado.");

  return contactId;
}

async function createLead({ nome }, contactId, { baseUrl, token }) {
  const body = [
    {
      name: `Lead Landing MRL - ${nome}`,
      _embedded: {
        contacts: [{ id: contactId }],
      },
    },
  ];

  const json = await kommoFetch(`${baseUrl}/api/v4/leads`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });

  const leadId = json?._embedded?.leads?.[0]?.id;
  if (!leadId) throw new Error("Não consegui obter o ID do lead criado.");

  return leadId;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST." });

    const baseUrl = getKommoBaseUrl();
    const token = getKommoToken();

    const body = await readJson(req);

    const nome = safeTrim(body.nome);
    const telefone = normalizePhoneBR(body.telefone || body.whatsapp || "");

    if (!nome || nome.length < 2) {
      return res.status(400).json({ ok: false, error: "Informe um nome válido." });
    }
    if (telefone && telefone.length < 12) {
      return res.status(400).json({ ok: false, error: "Telefone/WhatsApp inválido." });
    }

    const contactId = await createContact({ nome, telefone }, { baseUrl, token });
    const leadId = await createLead({ nome }, contactId, { baseUrl, token });

    return res.status(200).json({ ok: true, contactId, leadId });
  } catch (err) {
    return res.status(err.status || 500).json({
      ok: false,
      error: err.message || "Erro inesperado",
      details: err.payload || null,
    });
  }
}
