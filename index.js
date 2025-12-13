require("dotenv").config();
const express = require("express");
const cors = require("cors");
const wppconnect = require("@wppconnect-team/wppconnect");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());  

// --- CONFIGURAÇÃO ---
const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey =
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_KEY;
const openaiKey = process.env.OPENAI_API_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ ERRO: Faltam chaves no .env");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: openaiKey });
const SESSIONS = {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));


function normalizarNumeroWhats(message) {
  if (!message) return null;

  // Caso venha como LID, tenta pegar o número real
  if (message.from?.endsWith("@lid")) {
    return message.sender?.id || null;
  }

  return message.from;
}

function limparNumero(phone) {
  return phone
    ?.replace("@c.us", "")
    .replace("@lid", "");
}


async function gerarResumoConversa(supabase, conversationId, tenantId) {
  try {
    const { data: messages } = await supabase
      .from("messages")
      .select("sender_type, content")
      .eq("conversation_id", conversationId)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: true })
      .limit(30);

    if (!messages || messages.length === 0) return null;

    const transcript = messages
      .map(m =>
        `${m.sender_type === "ai" ? "Bot" : "Cliente"}: ${m.content}`
      )
      .join("\n");

    const prompt = `
Analise a conversa abaixo e retorne APENAS um JSON válido no formato:

{
  "objective": "Objetivo principal do cliente",
  "summary": "Resumo claro e técnico do atendimento",
  "topics": ["Topico 1", "Topico 2"],
  "sentiment": "positive | neutral | negative"
}

Conversa:
${transcript}
`;

    const gpt = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "Você é um analista de atendimento ao cliente." },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
    });

    const raw = JSON.parse(gpt.choices[0].message.content);

    const resumo = {
      objective: raw.objective || null,
      summary: raw.summary || null,
      topics: Array.isArray(raw.topics) ? raw.topics : [],
      sentiment: ["positive", "neutral", "negative"].includes(raw.sentiment)
        ? raw.sentiment
        : "neutral",
    };

    await supabase
      .from("conversations")
      .update(resumo)
      .eq("id", conversationId)
      .eq("tenant_id", tenantId);

    return resumo;
  } catch (e) {
    console.error("Erro resumo:", e);
    return null;
  }
}



// --- 1. ESPIÃO DE DADOS (Agora retorna se achou algo) ---
async function extrairDadosContato(
  supabase,
  tenantId,
  contactId,
  messageBody,
  currentName,
  currentEmail
) {
  if (currentName && currentName !== messageBody && currentEmail) return false;
  try {
    const gpt = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `Extraia JSON {"name": "...", "email": "..."} de: "${messageBody}". Dados atuais: ${currentName}, ${currentEmail}.`,
        },
      ],
      response_format: { type: "json_object" },
    });
    const data = JSON.parse(gpt.choices[0].message.content);
    const update = {};
    if (data.name && (!currentName || currentName === messageBody))
      update.name = data.name;
    if (data.email && !currentEmail) update.email = data.email;

    if (Object.keys(update).length > 0) {
      console.log(`🕵️‍♂️ Dados Novos:`, update);
      await supabase.from("contacts").update(update).eq("id", contactId);
      return true; // Avisa que atualizou
    }
  } catch (e) {}
  return false;
}


  
// --- SALVAR MENSAGEM ---
async function salvarMensagem(tenantId, message, fromMe = false, content = "") {
  const session = SESSIONS[tenantId];
  if (!session || !session.supabase) return null;
  const sb = session.supabase;
const phone = limparNumero(
  normalizarNumeroWhats(message) || message.to
);
  const name = message.notifyName || phone;
  const body = content || message.body;

  try {
    let { data: contact } = await sb
      .from("contacts")
      .select("id, name, email")
      .eq("tenant_id", tenantId)
      .eq("phone_number", phone)
      .maybeSingle();
    if (!contact) {
      const { data: newC } = await sb
        .from("contacts")
        .insert({
          tenant_id: tenantId,
          phone_number: phone,
          name: name,
          last_interaction_at: new Date().toISOString(),
        })
        .select()
        .single();
      contact = newC;
    } else {
      await sb
        .from("contacts")
        .update({ last_interaction_at: new Date().toISOString() })
        .eq("id", contact.id);
    }

    let { data: conversation } = await sb
      .from("conversations")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("contact_id", contact.id)
      .eq("status", "active")
      .maybeSingle();
    if (!conversation) {
      const { data: newConv } = await sb
        .from("conversations")
.insert({
  tenant_id: tenantId,
  contact_id: contact.id,
  phone_number: `${phone}@c.us`,
  status: "active",
  is_ai_active: true,
  provider: "meta",
})

        .select()
        .single();
      conversation = newConv;
    }

    const { data: msgSalva } = await sb
      .from("messages")
      .insert({
        conversation_id: conversation.id,
        tenant_id: tenantId,
        sender_type: fromMe ? "ai" : "customer",
        content: body,
        message_type: "text",
        provider: "meta",
        is_read: fromMe,
      })
      .select()
      .single();

    await sb
      .from("conversations")
      .update({
        last_message: body,
        last_message_at: new Date().toISOString(),
        unread_count: fromMe ? 0 : (conversation.unread_count || 0) + 1,
      })
      .eq("id", conversation.id);

    return { conversation, contact, messageId: msgSalva?.id };
  } catch (e) {
    console.error("Erro salvar:", e);
    return null;
  }
}

// --- ROTAS ---
app.post("/iniciar", async (req, res) => {
  const { tenantId } = req.body;
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ erro: "Token ausente" });

  const supabaseAuthenticated = createClient(supabaseUrl, supabaseKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const {
    data: { user },
  } = await supabaseAuthenticated.auth.getUser();
  if (!user) return res.status(403).json({ erro: "Token inválido" });

  console.log(`📢 Iniciando: ${tenantId}`);
  if (SESSIONS[tenantId] && SESSIONS[tenantId].client) {
    SESSIONS[tenantId].supabase = supabaseAuthenticated;
    return res.json({ mensagem: "OK", status: SESSIONS[tenantId].status });
  }
  SESSIONS[tenantId] = {
    status: "INICIANDO",
    qr: null,
    client: null,
    supabase: supabaseAuthenticated,
  };
  iniciarWPP(tenantId);
  res.json({ mensagem: "Inicializando..." });
});

app.post("/summarize", async (req, res) => {
    const { tenantId, conversationId } = req.body;
    const session = SESSIONS[tenantId];
    if (!session || !session.supabase) return res.status(400).json({ erro: "Sessão inválida" });

    const resumo = await gerarResumoConversa(session.supabase, conversationId, tenantId);
    if(resumo) res.json({ success: true, summary: resumo });
    else res.status(500).json({ success: false });
});

app.get("/status", (req, res) => {
  const activeTenant = Object.keys(SESSIONS)[0];
  if (!activeTenant) return res.json({ status: "DESCONECTADO" });
  res.json({
    status: SESSIONS[activeTenant].status,
    qrcode: SESSIONS[activeTenant].qr,
  });
});

app.post("/send-message", async (req, res) => {
  const { conversationId, content, tenantId } = req.body;
  const session = SESSIONS[tenantId];
  if (!session || !session.client)
    return res.status(400).json({ erro: "Desconectado" });
  try {
    const { data: conv } = await session.supabase
      .from("conversations")
      .select("phone_number")
      .eq("id", conversationId)
      .single();
    if (conv) {
      await session.client.sendText(conv.phone_number, content);
      res.json({ success: true });
    } else res.status(404).json({ erro: "404" });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

async function iniciarWPP(tenantId) {
  try {
    await wppconnect
      .create({
        session: tenantId,
        catchQR: (base64Qr) => {
          if (SESSIONS[tenantId]) {
            SESSIONS[tenantId].qr = base64Qr;
            SESSIONS[tenantId].status = "QRCODE";
          }
        },
       statusFind: (status) => {
  if (
    SESSIONS[tenantId] &&
    (status === "inChat" || status === "isLogged")
  ) {
    SESSIONS[tenantId].status = "CONECTADO";
    SESSIONS[tenantId].qr = null;

    // 🔥 MARCA O MOMENTO DA CONEXÃO
    SESSIONS[tenantId].connectedAt = Date.now();

    console.log(
      `🟢 Bot conectado em ${new Date(
        SESSIONS[tenantId].connectedAt
      ).toISOString()}`
    );
  }
},

        headless: true,
        logQR: false,
        puppeteerOptions: { userDataDir: `./tokens/${tenantId}/.data` },
      })
      .then((client) => {
        if (SESSIONS[tenantId]) {
          SESSIONS[tenantId].client = client;
          start(client, tenantId);
        }
      });
  } catch (e) {
    if (SESSIONS[tenantId]) SESSIONS[tenantId].status = "ERRO";
  }
}

// --- CÉREBRO ---
function start(client, tenantId) {
  console.log(`🤖 Robô Ativo: ${tenantId}`);

 client.onMessage(async (message) => {
  if (
    message.isGroupMsg ||
    message.fromMe ||
    message.from === "status@broadcast"
  )
    return;

  // ⛔ IGNORA MENSAGENS ANTES DA CONEXÃO
  const connectedAt = SESSIONS[tenantId]?.connectedAt;
  const messageTimestamp = message.timestamp * 1000;

  if (!connectedAt || messageTimestamp < connectedAt) return;

    console.log(`📩 Recebido: ${message.body}`);
    const session = SESSIONS[tenantId];
    if (!session || !session.supabase) return;

    const savedData = await salvarMensagem(tenantId, message);
    if (!savedData) return;
    // let contact = savedData.contact; <- NÃO USAR ESSE MAIS, ESTÁ DESATUALIZADO
    const { conversation, messageId } = savedData;

    if (!conversation.is_ai_active) return;

    // 1. ESPIONAGEM + ATUALIZAÇÃO FORÇADA
    // Usamos await para garantir que o banco atualize antes de prosseguirmos
    await extrairDadosContato(
      session.supabase,
      tenantId,
      savedData.contact.id,
      message.body,
      savedData.contact.name,
      savedData.contact.email
    );

    // --- A MÁGICA: RECARREGAR O CONTATO DO BANCO ---
    // Isso garante que se o nome acabou de ser salvo, a gente saiba disso AGORA
    const { data: refreshedContact } = await session.supabase
      .from("contacts")
      .select("name, email, phone_number")
      .eq("id", savedData.contact.id)
      .single();

    // Usamos o contato atualizado daqui pra frente
    const contact = refreshedContact || savedData.contact;

   
    try {
  // 🔹 Histórico da conversa
  const { data: historyData } = await session.supabase
    .from("messages")
    .select("id, sender_type, content, created_at")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: false })
    .limit(10);

  const cleanHistory = (historyData || [])
    .filter((m) => m.id !== messageId)
    .reverse()
    .map((msg) => ({
      role: msg.sender_type === "ai" ? "assistant" : "user",
      content: msg.content,
    }));

  // 🔹 Configuração da empresa
  const { data: aiConfig } = await session.supabase
    .from("ai_configurations")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  const businessName = aiConfig?.business_name || "Nossa Empresa";
  const businessDescription =
    aiConfig?.business_description ||
    "Somos especialistas em processos de imigração.";

  // 🔹 Estado do contato
  const missingName =
    !contact.name || contact.name === contact.phone_number;
  const missingEmail = !contact.email;

  // 🔹 SYSTEM PROMPT BASE
  let systemPrompt = `
VOCÊ É UM ASSISTENTE VIRTUAL DA EMPRESA ${businessName}.

SOBRE A EMPRESA:
${businessDescription}

TOM DE VOZ:
Profissional, educado, claro e humano.
`;

  // 🟡 MODO ONBOARDING (CADASTRO)
  if (missingName || missingEmail) {
    systemPrompt += `
OBJETIVO PRINCIPAL:
Você está na PRIMEIRA ETAPA do atendimento.

AÇÃO OBRIGATÓRIA:
1. Cumprimente o cliente
2. Informe que ele está falando com a empresa ${businessName}
3. Explique que precisa de alguns dados para continuar o atendimento
4. Peça APENAS os dados que faltam

REGRAS:
- NÃO responda dúvidas sobre imigração ainda
- NÃO faça vendas
- NÃO faça promessas
- Seja direto e educado
`;

    if (missingName) {
      systemPrompt += `
DADO FALTANTE: Nome
Peça o nome do cliente de forma natural.
`;
    } else if (missingEmail) {
      systemPrompt += `
DADO FALTANTE: Email
Explique que o email será usado para acompanhamento do atendimento.
`;
    }
  }

  // 🟢 MODO CONSULTORIA (IMIGRAÇÃO)
  else {
    systemPrompt += `
OBJETIVO:
Ajudar o cliente com dúvidas sobre imigração.

REGRAS:
- Responda apenas sobre imigração
- Seja claro e responsável
- Nunca invente leis ou garantias
- Sempre deixe claro que cada caso é individual
- Use os serviços e especialidades da empresa ${businessName} como base

ENCAMINHAMENTO:
Se o caso for complexo ou exigir análise humana,
ofereça falar com um especialista.
`;
  }

  // 🔴 TRANSFERÊNCIA HUMANA (ÚNICA EXCEÇÃO)
  systemPrompt += `
REGRA DE TRANSFERÊNCIA PARA HUMANO:
1. Se o cliente pedir para falar com um atendente, humano ou especialista
2. Se agradecer e encerrar a conversa
3. Se você perceber que não consegue ajudar

AÇÃO:
Pergunte: "Deseja que eu transfira para um atendente humano?"

CONFIRMAÇÃO:
Se o cliente responder SIM, QUERO ou ALGUMA COISA QUE CONFIRME responda APENAS:
[TRANSFER_HUMAN]
`;

  // 🔹 Enviar para GPT
  const messagesPayload = [
    { role: "system", content: systemPrompt },
    ...cleanHistory,
    { role: "user", content: message.body },
  ];

  const gptResponse = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: messagesPayload,
    temperature: 0.4,
  });

  const respostaIA = gptResponse.choices[0].message.content.trim();

  // 🔁 Transferência
  if (respostaIA.includes("[TRANSFER_HUMAN]")) {
    await session.supabase
      .from("conversations")
      .update({ status: "pending", is_ai_active: false })
      .eq("id", conversation.id);

    const msg = "Certo, vou te transferir para um atendente humano 👨‍💼";
    await client.sendText(message.from, msg);
    await salvarMensagem(tenantId, message, true, msg);
    await gerarResumoConversa(
  session.supabase,
  conversation.id,
  tenantId
);

    return;
  }

  // ⏳ Delay humano
  await client.startTyping(message.from);
  const delayTime = Math.min(Math.max(respostaIA.length * 40, 1500), 6000);
  await sleep(delayTime);
  await client.stopTyping(message.from);

  // 📤 Enviar mensagem
 
  const whatsappId =
  normalizarNumeroWhats(message) || `${contact.phone_number}@c.us`;

await client.sendText(whatsappId, respostaIA);
await salvarMensagem(tenantId, message, true, respostaIA);


} catch (error) {
  console.error("Erro IA:", error);
}

  });
}

app.listen(3000, () => console.log("🌐 Backend Sincronizado rodando!"));
