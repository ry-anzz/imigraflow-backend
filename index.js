require("dotenv").config();
const express = require("express");
const cors = require("cors");
const wppconnect = require("@wppconnect-team/wppconnect");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());  

// --- CONFIGURAÇÃO ---
const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!supabaseUrl || !supabaseKey || !geminiApiKey) {
  console.error("❌ ERRO: Faltam chaves no .env (Verifique Supabase e Gemini)");
  process.exit(1);
}

// Inicializa o Gemini
const genAI = new GoogleGenerativeAI(geminiApiKey);
const SESSIONS = {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizarNumeroWhats(message) {
  if (!message) return null;
  if (message.from?.endsWith("@lid")) {
    return message.sender?.id || null;
  }
  return message.from;
}

function limparNumero(phone) {
  return phone?.replace("@c.us", "").replace("@lid", "");
}

// --- FUNÇÃO DE RESUMO ---
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
      .map(m => `${m.sender_type === "ai" ? "Bot" : "Cliente"}: ${m.content}`)
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
    // 🔥 Atualizado para a versão mais recente do Gemini
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: { responseMimeType: "application/json", temperature: 0.3 }
    });

    const result = await model.generateContent(prompt);
    const raw = JSON.parse(result.response.text());

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

// --- 1. ESPIÃO DE DADOS ---
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
    const prompt = `Você é um extrator de dados. Extraia as seguintes informações da mensagem abaixo. Retorne APENAS um JSON no formato {"name": "...", "email": "..."}. Se não encontrar algum dado, deixe em branco.
    Dados que já possuímos: Nome=${currentName}, Email=${currentEmail}.
    Mensagem do cliente: "${messageBody}"`;

    // 🔥 Atualizado para a versão mais recente do Gemini
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
    });

    const result = await model.generateContent(prompt);
    const data = JSON.parse(result.response.text());
    
    const update = {};
    if (data.name && (!currentName || currentName === messageBody)) update.name = data.name;
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
  const phone = limparNumero(normalizarNumeroWhats(message) || message.to);
  const name = message.notifyName || phone;
  const body = content || message.body;

  try {
    let { data: contact } = await sb
      .from("contacts")
      .select("id, name, email")
      .eq("tenant_id", tenantId)
      .eq("phone_number", phone)
      .maybeSingle();
      
    // 🛡️ Prevenção contra corrida (Race Condition) ao cadastrar rapidamente
    if (!contact) {
      const { data: newC, error: insertError } = await sb
        .from("contacts")
        .insert({
          tenant_id: tenantId,
          phone_number: phone,
          name: name,
          last_interaction_at: new Date().toISOString(),
        })
        .select()
        .maybeSingle();

      if (insertError || !newC) {
        // Se falhou (provavelmente outra msg criou junto), buscamos novamente
        const { data: existingC } = await sb
          .from("contacts")
          .select("id, name, email")
          .eq("tenant_id", tenantId)
          .eq("phone_number", phone)
          .maybeSingle();
        contact = existingC;
      } else {
        contact = newC;
      }
    } else {
      await sb
        .from("contacts")
        .update({ last_interaction_at: new Date().toISOString() })
        .eq("id", contact.id);
    }

    if (!contact) return null;

    let { data: conversation } = await sb
      .from("conversations")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("contact_id", contact.id)
      .eq("status", "active")
      .maybeSingle();
      
    // 🛡️ Prevenção contra corrida ao criar a conversa
    if (!conversation) {
      const { data: newConv, error: convError } = await sb
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
        .maybeSingle();

      if (convError || !newConv) {
         const { data: existingConv } = await sb
          .from("conversations")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("contact_id", contact.id)
          .eq("status", "active")
          .maybeSingle();
         conversation = existingConv;
      } else {
         conversation = newConv;
      }
    }

    if (!conversation) return null;

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
  
  const { data: { user }, error } = await supabaseAuthenticated.auth.getUser();
  
  if (error) {
    console.error("❌ Erro de Autenticação Supabase:", error.message);
  }

  if (!user) return res.status(403).json({ erro: "Token inválido", detalhes: error?.message });

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
          if (SESSIONS[tenantId] && (status === "inChat" || status === "isLogged")) {
            SESSIONS[tenantId].status = "CONECTADO";
            SESSIONS[tenantId].qr = null;
            SESSIONS[tenantId].connectedAt = Date.now();
          }
        },
        headless: true,
        logQR: false,
        disableWelcome: true, 
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
    // 🛡️ Prevenção básica: ignora grupos, próprias mensagens, status
    if (
      message.isGroupMsg ||
      message.fromMe ||
      message.from === "status@broadcast"
    )
      return;

    // 🛡️ Ignora mensagens vazias ou de tipos não suportados (evita o "request is not iterable")
    if (!message.body || typeof message.body !== 'string' || message.body === 'undefined') {
      console.log(`⚠️ Mensagem ignorada (não é texto ou está vazia)`);
      return;
    }

    const connectedAt = SESSIONS[tenantId]?.connectedAt;
    const messageTimestamp = message.timestamp * 1000;

    if (!connectedAt || messageTimestamp < connectedAt) return;

    console.log(`📩 Recebido: ${message.body}`);
    const session = SESSIONS[tenantId];
    if (!session || !session.supabase) return;

    const savedData = await salvarMensagem(tenantId, message);
    if (!savedData) return;

    const { conversation, messageId } = savedData;

    if (!conversation.is_ai_active) return;

    // Tenta extrair dados silenciosamente. Se der erro de cota aqui, apenas ignoramos.
    try {
      await extrairDadosContato(
        session.supabase,
        tenantId,
        savedData.contact.id,
        message.body,
        savedData.contact.name,
        savedData.contact.email
      );
    } catch (e) {
      console.log(`⚠️ Falha na extração de dados (possível limite de cota)`);
    }

    const { data: refreshedContact } = await session.supabase
      .from("contacts")
      .select("name, email, phone_number")
      .eq("id", savedData.contact.id)
      .single();

    const contact = refreshedContact || savedData.contact;

    try {
      const { data: historyData } = await session.supabase
        .from("messages")
        .select("id, sender_type, content, created_at")
        .eq("conversation_id", conversation.id)
        .order("created_at", { ascending: false })
        .limit(8); // Reduzimos um pouco o histórico para economizar tokens

      const cleanHistory = (historyData || [])
        .filter((m) => m.id !== messageId)
        .reverse()
        .map((msg) => ({
          role: msg.sender_type === "ai" ? "model" : "user",
          parts: [{ text: msg.content }],
        }));

      const { data: aiConfig } = await session.supabase
        .from("ai_configurations")
        .select("*")
        .eq("tenant_id", tenantId)
        .maybeSingle();

      const businessName = aiConfig?.business_name || "Nossa Empresa";
      const businessDescription =
        aiConfig?.business_description ||
        "Somos especialistas em processos de imigração.";

      const missingName = !contact.name || contact.name === contact.phone_number;
      const missingEmail = !contact.email;

      let systemPrompt = `
VOCÊ É UM ASSISTENTE VIRTUAL DA EMPRESA ${businessName}.

SOBRE A EMPRESA:
${businessDescription}

TOM DE VOZ:
Profissional, educado, claro e humano.
`;

      if (missingName || missingEmail) {
        systemPrompt += `
OBJETIVO PRINCIPAL: Você está na PRIMEIRA ETAPA do atendimento.
AÇÃO OBRIGATÓRIA:
1. Cumprimente o cliente.
2. Peça APENAS os dados que faltam abaixo. Não responda dúvidas.
`;
        if (missingName) systemPrompt += `\nDADO FALTANTE: Nome\nPeça o nome do cliente.`;
        else if (missingEmail) systemPrompt += `\nDADO FALTANTE: Email\nPeça o email do cliente.`;
      } else {
        systemPrompt += `
OBJETIVO: Ajudar o cliente com dúvidas sobre imigração.
REGRAS: Responda apenas sobre imigração. Seja claro. Se for complexo, ofereça um humano.
`;
      }

      systemPrompt += `
REGRA DE TRANSFERÊNCIA PARA HUMANO:
Se o cliente pedir um humano ou não puder ser ajudado, responda APENAS:
[TRANSFER_HUMAN]
`;

      const chatModel = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        systemInstruction: systemPrompt,
        generationConfig: { temperature: 0.4 },
      });

      const chat = chatModel.startChat({
        history: cleanHistory,
      });

      // 🛡️ Tenta enviar a mensagem para a IA
      const gptResponse = await chat.sendMessage(message.body);
      const respostaIA = gptResponse.response.text().trim();

      if (respostaIA.includes("[TRANSFER_HUMAN]")) {
        await session.supabase
          .from("conversations")
          .update({ status: "pending", is_ai_active: false })
          .eq("id", conversation.id);

        const msg = "Certo, vou te transferir para um atendente humano 👨‍💼";
        await client.sendText(message.from, msg);
        await salvarMensagem(tenantId, message, true, msg);
        // Ocultado o resumo de conversa para economizar requisições da cota gratuita
        // await gerarResumoConversa(session.supabase, conversation.id, tenantId);
        return;
      }

      await client.startTyping(message.from);
      const delayTime = Math.min(Math.max(respostaIA.length * 40, 1500), 6000);
      await sleep(delayTime);
      await client.stopTyping(message.from);

      const whatsappId = normalizarNumeroWhats(message) || `${contact.phone_number}@c.us`;
      await client.sendText(whatsappId, respostaIA);
      await salvarMensagem(tenantId, message, true, respostaIA);

    } catch (error) {
      console.error("❌ Erro IA:", error.message);
      
      // 🛡️ Se der erro 429 (Limite Excedido), enviamos uma mensagem amigável para o cliente
      if (error.status === 429) {
        const whatsappId = normalizarNumeroWhats(message) || `${contact.phone_number}@c.us`;
        const msgLimite = "Nosso sistema está processando muitas informações no momento. Por favor, aguarde cerca de um minuto e envie sua mensagem novamente.";
        await client.sendText(whatsappId, msgLimite);
        await salvarMensagem(tenantId, message, true, msgLimite);
      }
    }
  });
}

app.listen(3000, () => console.log("🌐 Backend Sincronizado rodando (Com Gemini Atualizado)!"));