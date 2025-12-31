// /api/lead.js
// Vercel Serverless Function (Node)
// ENV na Vercel:
// - KOMMO_SUBDOMAIN = mrltravel
// - KOMMO_TOKEN = <access token sem "Bearer">

function onlyDigits(v = "") {
  return String(v).replace(/\D/g, "");
}

function normalizePhoneBR(v = "") {
  // Retorna somente dígitos, sempre começando com 55 + DDD + número (12 ou 13 dígitos)
  const d = onlyDigits(v);
  if (!d) return "";

  if (d.startsWith("55")) {
    const rest = d.slice(2).slice(0, 11);
    return "55" + rest;
  }

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

async function getCustomFieldIds(baseUrl, token) {
  const ids = { contacts: new Set(), leads: new Set() };

  try {
    const c = await kommoFetch(`${baseUrl}/api/v4/contacts/custom_fields`, token, { method: "GET" });
    const arr = c?._embedded?.custom_fields || [];
    arr.forEach((f) => ids.contacts.add(Number(f.id)));
  } catch {}

  try {
    const l = await kommoFetch(`${baseUrl}/api/v4/leads/custom_fields`, token, { method: "GET" });
    const arr = l?._embedded?.custom_fields || [];
    arr.forEach((f) => ids.leads.add(Number(f.id)));
  } catch {}

  return ids;
}

function buildCustomFieldsValues(pairs) {
  const out = [];
  for (const p of pairs) {
    if (!p) continue;

    // aceita field_id OU field_code
    const hasFieldId = p.field_id !== undefined && p.field_id !== null;
    const hasFieldCode = p.field_code !== undefined && p.field_code !== null;

    if (!hasFieldId && !hasFieldCode) continue;

    const value = p.value;
    if (value === undefined || value === null || String(value).trim() === "") continue;

    const obj = {
      values: [{ value: String(value) }],
    };

    if (hasFieldId) obj.field_id = Number(p.field_id);
    if (hasFieldCode) obj.field_code = String(p.field_code);

    out.push(obj);
  }
  return out;
}

async function patchEntityTags(entityType, entityId, tags, { baseUrl, token }) {
  const clean = (tags || [])
    .map((t) => safeTrim(t))
    .filter(Boolean)
    .map((name) => ({ name }));

  if (!clean.length) return;

  // PATCH https://{subdomain}.kommo.com/api/v4/{entity_type}/{id}
  // body: { "_embedded": { "tags": [ { "name": "..." } ] } }
  await kommoFetch(`${baseUrl}/api/v4/${entityType}/${entityId}`, token, {
    method: "PATCH",
    body: JSON.stringify({ _embedded: { tags: clean } }),
  });
}

async function createContact({ nome, telefone, email }, { baseUrl, token }, fieldIds) {
  const pairs = [];

  // Nome no campo customizado 1024823 (se existir em contacts)
  if (fieldIds?.contacts?.has(1024823)) {
    pairs.push({ field_id: 1024823, value: nome });
  }

  // Telefone: usa field_id 1024825 se existir, senão field_code PHONE
  if (telefone) {
    if (fieldIds?.contacts?.has(1024825)) {
      pairs.push({ field_id: 1024825, value: telefone });
    } else {
      pairs.push({ field_code: "PHONE", value: telefone });
    }
  }

  // Email (opcional)
  if (email) pairs.push({ field_code: "EMAIL", value: email });

  const bodyContact = { name: nome };
  const custom = buildCustomFieldsValues(pairs);
  if (custom.length) bodyContact.custom_fields_values = custom;

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
    _embedded: {
      contacts: [{ id: contactId }],
    },
  };

  // Se esses campos existirem em leads, preenche também
  const leadPairs = [];
  if (fieldIds?.leads?.has(1024823)) leadPairs.push({ field_id: 1024823, value: nome });
  if (telefone && fieldIds?.leads?.has(1024825)) leadPairs.push({ field_id: 1024825, value: telefone });

  const leadCustom = buildCustomFieldsValues(leadPairs);
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

    // Tags no Lead (após criar)
    await patchEntityTags("leads", leadId, ["Landing Page", "Grupo VIP"], { baseUrl, token });

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
