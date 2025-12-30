// api/lead.js
// Vercel Serverless Function
// ENV na Vercel:
// - KOMMO_SUBDOMAIN = mrltravel
// - KOMMO_TOKEN = <access token sem "Bearer">

function onlyDigits(v = "") {
  return String(v).replace(/\D/g, "");
}

function normalizePhoneBR(v = "") {
  // Retorna "+55" + DDD + número (ex: +5537999999999)
  const d = onlyDigits(v);

  if (!d) return "";
  if (d.startsWith("55")) {
    const rest = d.slice(2);
    const local = rest.slice(0, 11);
    return "+55" + local;
  }

  const local = d.slice(0, 11);
  return "+55" + local;
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

async function getCustomFieldIds(baseUrl, token) {
  // Descobre onde existem os field_ids (contacts vs leads)
  // Se algum endpoint falhar, segue com fallback.
  const ids = {
    contacts: new Set(),
    leads: new Set(),
  };

  try {
    const c = await kommoFetch(`${baseUrl}/api/v4/contacts/custom_fields`, token, { method: "GET" });
    const arr = c?._embedded?.custom_fields || [];
    arr.forEach((f) => ids.contacts.add(Number(f.id)));
  } catch {
    // ignora
  }

  try {
    const l = await kommoFetch(`${baseUrl}/api/v4/leads/custom_fields`, token, { method: "GET" });
    const arr = l?._embedded?.custom_fields || [];
    arr.forEach((f) => ids.leads.add(Number(f.id)));
  } catch {
    // ignora
  }

  return ids;
}

function buildCustomFieldsValues(pairs) {
  // pairs: [{ field_id, value }]
  const out = [];
  for (const p of pairs) {
    if (!p.field_id) continue;
    if (p.value === undefined || p.value === null || String(p.value).trim() === "") continue;

    out.push({
      field_id: Number(p.field_id),
      values: [{ value: String(p.value) }],
    });
  }
  return out;
}

async function createContact({ nome, telefone, email }, { baseUrl, token }, fieldIds) {
  // Contato sempre tem "name". Para telefone, usa fallback seguro com field_code PHONE se o field_id não existir em Contacts.
  const customPairs = [];

  // Se o ID 1024823 existir em contacts, preenche também (além do name padrão)
  if (fieldIds.contacts.has(1024823)) customPairs.push({ field_id: 1024823, value: nome });

  // Se o ID 1024825 existir em contacts, usa ele. Caso contrário, usa field_code PHONE.
  const usePhoneFieldId = fieldIds.contacts.has(1024825);

  const bodyContact = {
    name: nome,
  };

  const customFields = buildCustomFieldsValues(customPairs);
  if (customFields.length) bodyContact.custom_fields_values = customFields;

  // Phone via field_code PHONE (fallback mais confiável)
  if (telefone) {
    if (usePhoneFieldId) {
      bodyContact.custom_fields_values = [
        ...(bodyContact.custom_fields_values || []),
        {
          field_id: 1024825,
          values: [{ value: telefone }],
        },
      ];
    } else {
      bodyContact.custom_fields_values = [
        ...(bodyContact.custom_fields_values || []),
        {
          field_code: "PHONE",
          values: [{ value: telefone }],
        },
      ];
    }
  }

  // Email (se quiser gravar no Kommo também)
  if (email) {
    bodyContact.custom_fields_values = [
      ...(bodyContact.custom_fields_values || []),
      {
        field_code: "EMAIL",
        values: [{ value: email }],
      },
    ];
  }

  const json = await kommoFetch(`${baseUrl}/api/v4/contacts`, token, {
    method: "POST",
    body: JSON.stringify([bodyContact]),
  });

  const contactId = json?._embedded?.contacts?.[0]?.id;
  if (!contactId) throw new Error("Não consegui obter o ID do contato criado.");

  return contactId;
}

async function createLead({ nome, telefone }, contactId, { baseUrl, token }, fieldIds) {
  const leadObj = {
    name: `Lead Landing MRL - ${nome}`,
    _embedded: { contacts: [{ id: contactId }] },
  };

  // Se os IDs existirem em leads, preenche lá também
  const leadCustomPairs = [];
  if (fieldIds.leads.has(1024823)) leadCustomPairs.push({ field_id: 1024823, value: nome });
  if (telefone && fieldIds.leads.has(1024825)) leadCustomPairs.push({ field_id: 1024825, value: telefone });

  const leadCustom = buildCustomFieldsValues(leadCustomPairs);
  if (leadCustom.length) leadObj.custom_fields_values = leadCustom;

  const json = await kommoFetch(`${baseUrl}/api/v4/leads`, token, {
    method: "POST",
    body: JSON.stringify([leadObj]),
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
    const email = safeTrim(body.email || "");

    if (!nome || nome.length < 2) return res.status(400).json({ ok: false, error: "Informe um nome válido." });
    if (telefone && telefone.length < 12) return res.status(400).json({ ok: false, error: "Telefone/WhatsApp inválido." });

    const fieldIds = await getCustomFieldIds(baseUrl, token);

    const contactId = await createContact({ nome, telefone, email }, { baseUrl, token }, fieldIds);
    const leadId = await createLead({ nome, telefone }, contactId, { baseUrl, token }, fieldIds);

    return res.status(200).json({ ok: true, contactId, leadId });
  } catch (err) {
    console.error("Kommo lead error:", err?.message, err?.payload || err);
    return res.status(err.status || 500).json({
      ok: false,
      error: err.message || "Erro inesperado",
      details: err.payload || null,
    });
  }
}
