// api/lead.js
// Vercel Serverless Function (Node)
// ENV na Vercel:
// - KOMMO_SUBDOMAIN = mrltravel
// - KOMMO_TOKEN = <access token sem "Bearer">

function onlyDigits(v = "") {
  return String(v).replace(/\D/g, "");
}

function normalizePhoneBRDigits(v = "") {
  // Retorna sempre: 55 + DDD + número (até 13 dígitos)
  const d = onlyDigits(v);
  if (!d) return "";

  if (d.startsWith("55")) return d.slice(0, 13);
  return ("55" + d).slice(0, 13);
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

async function fetchCustomFieldIds(entity, { baseUrl, token }) {
  // entity: "contacts" | "leads"
  // Endpoint padrão Kommo v4: /api/v4/<entity>/custom_fields
  const ids = new Set();

  try {
    const json = await kommoFetch(`${baseUrl}/api/v4/${entity}/custom_fields`, token, {
      method: "GET",
    });
    const arr = json?._embedded?.custom_fields || [];
    arr.forEach((f) => ids.add(Number(f.id)));
  } catch {
    // Se falhar, só retorna Set vazio e seguimos com fallback por field_code
  }

  return ids;
}

function buildCustomFieldsValues(items) {
  // items: [{ field_id? , field_code?, value, enum_code? }]
  const out = [];

  for (const it of items) {
    if (!it) continue;
    const value = it.value;

    if (value === undefined || value === null || String(value).trim() === "") continue;

    if (it.field_id) {
      out.push({
        field_id: Number(it.field_id),
        values: [
          {
            value: String(value),
            ...(it.enum_code ? { enum_code: it.enum_code } : {}),
          },
        ],
      });
      continue;
    }

    if (it.field_code) {
      out.push({
        field_code: String(it.field_code),
        values: [{ value: String(value) }],
      });
    }
  }

  return out;
}

async function createContact({ nome, telefone, email }, { baseUrl, token }, contactFieldIds) {
  const pairs = [];

  // Nome (custom field 1024823) se existir em Contacts
  if (contactFieldIds.has(1024823)) {
    pairs.push({ field_id: 1024823, value: nome });
  }

  // Telefone: tenta field_id 1024825, se não existir usa field_code PHONE
  if (telefone) {
    if (contactFieldIds.has(1024825)) {
      pairs.push({ field_id: 1024825, value: telefone, enum_code: "WORK" });
    } else {
      pairs.push({ field_code: "PHONE", value: telefone });
    }
  }

  // Email: usa field_code EMAIL (normalmente existe)
  if (email) {
    pairs.push({ field_code: "EMAIL", value: email });
  }

  const contactObj = {
    name: nome,
    tags_to_add: [{ name: "Landing Grupo VIP" }],
  };

  const custom_fields_values = buildCustomFieldsValues(pairs);
  if (custom_fields_values.length) contactObj.custom_fields_values = custom_fields_values;

  const json = await kommoFetch(`${baseUrl}/api/v4/contacts`, token, {
    method: "POST",
    body: JSON.stringify([contactObj]),
  });

  const contactId = json?._embedded?.contacts?.[0]?.id;
  if (!contactId) throw new Error("Não consegui obter o ID do contato criado.");

  return contactId;
}

async function createLead({ nome, telefone }, contactId, { baseUrl, token }, leadFieldIds) {
  const leadObj = {
    name: `Lead Landing MRL - ${nome}`,
    _embedded: {
      contacts: [{ id: contactId }],
    },
    tags_to_add: [{ name: "Landing Page" }, { name: "Grupo VIP" }],
  };

  // Se quiser preencher custom fields no Lead também
  const pairs = [];

  if (leadFieldIds.has(1024823)) {
    pairs.push({ field_id: 1024823, value: nome });
  }

  if (telefone) {
    if (leadFieldIds.has(1024825)) {
      pairs.push({ field_id: 1024825, value: telefone, enum_code: "WORK" });
    } else {
      // em lead, nem sempre existe field_code PHONE, então só coloca se quiser arriscar:
      // pairs.push({ field_code: "PHONE", value: telefone });
    }
  }

  const custom_fields_values = buildCustomFieldsValues(pairs);
  if (custom_fields_values.length) leadObj.custom_fields_values = custom_fields_values;

  const json = await kommoFetch(`${baseUrl}/api/v4/leads`, token, {
    method: "POST",
    body: JSON.stringify([leadObj]),
  });

  const leadId = json?._embedded?.leads?.[0]?.id;
  if (!leadId) throw new Error("Não consegui obter o ID do lead criado.");

  return leadId;
}

module.exports = async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Use POST." });
    }

    const baseUrl = getKommoBaseUrl();
    const token = getKommoToken();

    const body = await readJson(req);

    const nome = safeTrim(body.nome);
    const telefone = normalizePhoneBRDigits(body.telefone || body.whatsapp || "");
    const email = safeTrim(body.email || "");

    if (!nome || nome.length < 2) {
      return res.status(400).json({ ok: false, error: "Informe um nome válido." });
    }

    if (telefone && telefone.length < 12) {
      return res.status(400).json({ ok: false, error: "Telefone/WhatsApp inválido." });
    }

    const [contactFieldIds, leadFieldIds] = await Promise.all([
      fetchCustomFieldIds("contacts", { baseUrl, token }),
      fetchCustomFieldIds("leads", { baseUrl, token }),
    ]);

    const contactId = await createContact(
      { nome, telefone, email },
      { baseUrl, token },
      contactFieldIds
    );

    const leadId = await createLead(
      { nome, telefone },
      contactId,
      { baseUrl, token },
      leadFieldIds
    );

    return res.status(200).json({ ok: true, contactId, leadId });
  } catch (err) {
    console.error("Kommo lead error:", err?.message, err?.payload || err);
    return res.status(err.status || 500).json({
      ok: false,
      error: err.message || "Erro inesperado",
      details: err.payload || null,
    });
  }
};
