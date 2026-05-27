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
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_KEY;
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

// ============================================================================
// 🛠️ FERRAMENTAS DE AGENDA (FUNCTION CALLING - INTEGRADO AO REACT)
// ============================================================================

async function buscarDisponibilidade(supabase, tenantId) {
  try {
    const hoje = new Date().toISOString();
    
    // 1. Puxa do banco as "consultas" que já existem
    const { data: agendamentos } = await supabase
      .from("consultas")
      .select("data_hora")
      .eq("tenant_id", tenantId)
      .gte("data_hora", hoje)
      .neq("status", "Cancelado"); // Ignora os cancelados

    const marcados = agendamentos?.map(a => new Date(a.data_hora).getTime()) || [];

    // 2. Gera opções (Próximos 3 dias úteis às 10h e 14h)
    const horariosDisponiveis = [];
    let diaAtual = new Date();
    
    for (let i = 1; i <= 3; i++) {
      diaAtual.setDate(diaAtual.getDate() + 1);
      // Pula finais de semana
      if (diaAtual.getDay() === 0 || diaAtual.getDay() === 6) continue;

      const op1 = new Date(diaAtual); op1.setHours(10, 0, 0, 0);
      const op2 = new Date(diaAtual); op2.setHours(14, 0, 0, 0);

      if (!marcados.includes(op1.getTime())) horariosDisponiveis.push(op1.toISOString().slice(0,16).replace('T', ' '));
      if (!marcados.includes(op2.getTime())) horariosDisponiveis.push(op2.toISOString().slice(0,16).replace('T', ' '));
    }

    return horariosDisponiveis.length > 0 
      ? horariosDisponiveis 
      : ["Não há horários disponíveis para os próximos dias."];
  } catch (e) {
    console.error("Erro ao buscar agenda:", e);
    return ["Erro no sistema ao consultar a agenda."];
  }
}

async function agendarConsulta(supabase, tenantId, contactId, dataHora, cpf) {
  try {
    const isoDate = new Date(dataHora).toISOString();
    
    // 1. Limpa o CPF (deixa só números)
    const cpfLimpo = cpf.replace(/\D/g, '');

    // 2. Busca se o CPF já é paciente oficial
    let { data: paciente } = await supabase
      .from('pacientes')
      .select('id_paciente')
      .eq('cpf', cpfLimpo)
      .maybeSingle();

    // 3. Se não existir, cria o paciente automaticamente
    if (!paciente) {
       const { data: contatoWhats } = await supabase.from('contacts').select('name, phone_number').eq('id', contactId).single();
       const nomePaciente = contatoWhats?.name || "Paciente do WhatsApp";
       
       const { data: novoPaciente, error: erroCriar } = await supabase
         .from('pacientes')
         .insert([{ nome: nomePaciente, cpf: cpfLimpo }])
         .select('id_paciente')
         .single();
         
       if (erroCriar) throw erroCriar;
       paciente = novoPaciente;
    }

    // 4. Salva a consulta na tabela do seu React vinculada ao ID do paciente
    const { error } = await supabase
      .from("consultas")
      .insert([{
        tenant_id: tenantId,
        id_usuario: tenantId, 
        id_paciente: paciente.id_paciente,
        tipo_atendimento: 'Consulta IA',
        data_hora: isoDate,
        status: 'Agendado'
      }]);

    if (error) {
      console.error("Erro banco agendarConsulta:", error);
      throw error;
    }
    return { sucesso: true, mensagem: "Agendamento gravado e paciente vinculado com sucesso!" };
  } catch (error) {
    console.error("Erro ao agendar:", error);
    return { sucesso: false, mensagem: "Falha ao gravar o agendamento no banco de dados." };
  }
}

// ============================================================================
// FUNÇÕES EXISTENTES
// ============================================================================

async function gerarResumoConversa(supabase, conversationId, tenantId) {
  try {
    const { data: messages } = await supabase.from("messages").select("sender_type, content").eq("conversation_id", conversationId).eq("tenant_id", tenantId).order("created_at", { ascending: true }).limit(30);
    if (!messages || messages.length === 0) return null;
    const transcript = messages.map(m => `${m.sender_type === "ai" ? "Bot" : "Cliente"}: ${m.content}`).join("\n");
    const prompt = `Analise a conversa abaixo e retorne APENAS um JSON válido no formato:\n{"objective": "Objetivo", "summary": "Resumo", "topics": ["Topico"], "sentiment": "positive | neutral | negative"}\nConversa:\n${transcript}`;
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json", temperature: 0.3 } });
    const result = await model.generateContent(prompt);
    const raw = JSON.parse(result.response.text());
    const resumo = { objective: raw.objective || null, summary: raw.summary || null, topics: Array.isArray(raw.topics) ? raw.topics : [], sentiment: ["positive", "neutral", "negative"].includes(raw.sentiment) ? raw.sentiment : "neutral" };
    await supabase.from("conversations").update(resumo).eq("id", conversationId).eq("tenant_id", tenantId);
    return resumo;
  } catch (e) {
    console.error("Erro resumo:", e);
    return null;
  }
}

async function extrairDadosContato(supabase, tenantId, contactId, messageBody, currentName, currentEmail) {
  if (currentName && currentName !== messageBody && currentEmail) return false;
  try {
    const prompt = `Você é um extrator de dados. Extraia as seguintes informações da mensagem abaixo. Retorne APENAS um JSON no formato {"name": "...", "email": "..."}. Dados que já possuímos: Nome=${currentName}, Email=${currentEmail}. Mensagem do cliente: "${messageBody}"`;
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json", temperature: 0.1 } });
    const result = await model.generateContent(prompt);
    const data = JSON.parse(result.response.text());
    
    const update = {};
    if (data.name && (!currentName || currentName === messageBody)) update.name = data.name;
    if (data.email && !currentEmail) update.email = data.email;

    if (Object.keys(update).length > 0) {
      await supabase.from("contacts").update(update).eq("id", contactId);
      return true;
    }
  } catch (e) {}
  return false;
}

async function salvarMensagem(tenantId, message, fromMe = false, content = "") {
  const session = SESSIONS[tenantId];
  if (!session || !session.supabase) {
    console.error("❌ Erro: Sessão do Supabase não encontrada no Backend.");
    return null;
  }
  
  const sb = session.supabase;
  const phone = limparNumero(normalizarNumeroWhats(message) || message.to);
  const name = message.notifyName || phone;
  const body = content || message.body;

  try {
    let { data: contact, error: selectError } = await sb.from("contacts").select("id, name, email").eq("tenant_id", tenantId).eq("phone_number", phone).maybeSingle();
      
    if (!contact) {
      const { data: newC, error: insertError } = await sb.from("contacts").insert({ tenant_id: tenantId, phone_number: phone, name: name, last_interaction_at: new Date().toISOString() }).select().maybeSingle();
      if (insertError) {
        const { data: existingC } = await sb.from("contacts").select("id, name, email").eq("tenant_id", tenantId).eq("phone_number", phone).maybeSingle();
        contact = existingC;
      } else {
        contact = newC;
      }
    } else {
      await sb.from("contacts").update({ last_interaction_at: new Date().toISOString() }).eq("id", contact.id);
    }

    if (!contact) return null;

    let { data: conversation, error: convSelectError } = await sb.from("conversations").select("*").eq("tenant_id", tenantId).eq("contact_id", contact.id).eq("status", "active").maybeSingle();
      
    if (!conversation) {
      const { data: newConv, error: convError } = await sb.from("conversations").insert({ tenant_id: tenantId, contact_id: contact.id, phone_number: `${phone}@c.us`, status: "active", is_ai_active: true, provider: "meta" }).select().maybeSingle();
      if (convError) {
         const { data: existingConv } = await sb.from("conversations").select("*").eq("tenant_id", tenantId).eq("contact_id", contact.id).eq("status", "active").maybeSingle();
         conversation = existingConv;
      } else {
         conversation = newConv;
      }
    }

    if (!conversation) return null;

    const { data: msgSalva, error: msgError } = await sb.from("messages").insert({ conversation_id: conversation.id, tenant_id: tenantId, sender_type: fromMe ? "ai" : "customer", content: body, message_type: "text", provider: "meta", is_read: fromMe }).select().single();
    await sb.from("conversations").update({ last_message: body, last_message_at: new Date().toISOString(), unread_count: fromMe ? 0 : (conversation.unread_count || 0) + 1 }).eq("id", conversation.id);
    
    return { conversation, contact, messageId: msgSalva?.id };
  } catch (e) {
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
  if (!user) return res.status(403).json({ erro: "Token inválido" });

  console.log(`📢 Iniciando: ${tenantId}`);
  if (SESSIONS[tenantId] && SESSIONS[tenantId].client) {
    SESSIONS[tenantId].supabase = supabaseAuthenticated;
    return res.json({ mensagem: "OK", status: SESSIONS[tenantId].status });
  }
  
  SESSIONS[tenantId] = { status: "INICIANDO", qr: null, client: null, supabase: supabaseAuthenticated };
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
  res.json({ status: SESSIONS[activeTenant].status, qrcode: SESSIONS[activeTenant].qr });
});

app.post("/send-message", async (req, res) => {
  const { conversationId, content, tenantId } = req.body;
  const session = SESSIONS[tenantId];
  if (!session || !session.client) return res.status(400).json({ erro: "Desconectado" });
  try {
    const { data: conv } = await session.supabase.from("conversations").select("phone_number").eq("id", conversationId).single();
    if (conv) {
      await session.client.sendText(conv.phone_number, content);
      res.json({ success: true });
    } else res.status(404).json({ erro: "404" });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

async function iniciarWPP(tenantId) {
  try {
    await wppconnect.create({
        session: tenantId,
        autoClose: 600000, 
        catchQR: (base64Qr) => { if (SESSIONS[tenantId]) { SESSIONS[tenantId].qr = base64Qr; SESSIONS[tenantId].status = "QRCODE"; } },
        statusFind: (status) => { if (SESSIONS[tenantId] && (status === "inChat" || status === "isLogged")) { SESSIONS[tenantId].status = "CONECTADO"; SESSIONS[tenantId].qr = null; SESSIONS[tenantId].connectedAt = Date.now(); } },
        headless: true, logQR: false, disableWelcome: true, puppeteerOptions: { userDataDir: `./tokens/${tenantId}/.data` },
      }).then((client) => { if (SESSIONS[tenantId]) { SESSIONS[tenantId].client = client; start(client, tenantId); } });
  } catch (e) { if (SESSIONS[tenantId]) SESSIONS[tenantId].status = "ERRO"; }
}

// ============================================================================
// CÉREBRO
// ============================================================================
function start(client, tenantId) {
  console.log(`🤖 Robô Ativo: ${tenantId}`);

  if (SESSIONS[tenantId]) SESSIONS[tenantId].connectedAt = Date.now();

  client.onMessage(async (message) => {
    if (message.isGroupMsg || message.fromMe || message.from === "status@broadcast") return;
    if (!message.body || typeof message.body !== 'string' || message.body === 'undefined') return;

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

    try {
      await extrairDadosContato(session.supabase, tenantId, savedData.contact.id, message.body, savedData.contact.name, savedData.contact.email);
    } catch (e) {}

    const { data: refreshedContact } = await session.supabase.from("contacts").select("name, email, phone_number").eq("id", savedData.contact.id).single();
    const contact = refreshedContact || savedData.contact;

    try {
      const { data: historyData } = await session.supabase.from("messages").select("id, sender_type, content, created_at").eq("conversation_id", conversation.id).order("created_at", { ascending: false }).limit(8);
      const cleanHistory = (historyData || []).filter((m) => m.id !== messageId).reverse().map((msg) => ({ role: msg.sender_type === "ai" ? "model" : "user", parts: [{ text: msg.content }] }));
      const { data: aiConfig } = await session.supabase.from("ai_configurations").select("*").eq("tenant_id", tenantId).maybeSingle();

      const businessName = aiConfig?.business_name || "Nossa Clínica";
      const businessDescription = aiConfig?.business_description || "Somos especialistas em atendimento médico.";
      const missingName = !contact.name || contact.name === contact.phone_number;

      // 🧠 PROMPT ESTRATÉGICO
      let systemPrompt = `VOCÊ É O ASSISTENTE VIRTUAL DA EMPRESA ${businessName}.\nSOBRE: ${businessDescription}\nTOM: Profissional e direto.\n`;
      
      if (missingName) {
        systemPrompt += `AÇÃO OBRIGATÓRIA: Cumprimente e peça O NOME do cliente antes de seguir.\n`;
      } else {
        systemPrompt += `
REGRAS DE OURO PARA AGENDAMENTO:
1. Se o cliente pedir para marcar consulta, use a ferramenta 'buscarDisponibilidade'.
2. Apresente os horários de forma amigável e pergunte qual ele prefere.
3. Se o cliente escolher o horário, OBRIGATORIAMENTE peça o CPF dele.
4. SÓ use a ferramenta 'agendarConsulta' QUANDO tiver a Data/Hora escolhida E o CPF do cliente.
5. Confirme o sucesso APENAS após a ferramenta retornar resultado positivo.
6. Se o cliente se irritar ou pedir humano, responda: [TRANSFER_HUMAN]
`;
      }

      // 🛠️ DEFINIÇÃO DAS FERRAMENTAS PARA O GEMINI
      const tools = [{
        functionDeclarations: [
          {
            name: "buscarDisponibilidade",
            description: "Consulta a agenda do sistema e retorna dias e horários livres."
          },
          {
            name: "agendarConsulta",
            description: "Grava a consulta no banco de dados assim que o paciente fornecer o CPF e escolher o horário.",
            parameters: {
              type: "object",
              properties: {
                dataHora: { type: "string", description: "Data/Hora escolhida no formato 'YYYY-MM-DD HH:mm'" },
                cpf: { type: "string", description: "CPF do cliente contendo 11 dígitos numéricos." }
              },
              required: ["dataHora", "cpf"]
            }
          }
        ]
      }];

      const chatModel = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        systemInstruction: systemPrompt,
        tools: tools,
        generationConfig: { temperature: 0.3 },
      });

      const chat = chatModel.startChat({ history: cleanHistory });

      console.log(`🤖 Processando intenção do usuário...`);
      let gptResponse = await chat.sendMessage(message.body);
      
      // 🕵️‍♂️ VERIFICA SE A IA CHAMOU ALGUMA FERRAMENTA
      const functionCalls = gptResponse.response.functionCalls();
      
      if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0];
        console.log(`⚙️  A IA decidiu usar a ferramenta: [${call.name}]`);
        
        let toolResult;
        if (call.name === "buscarDisponibilidade") {
          toolResult = await buscarDisponibilidade(session.supabase, tenantId);
        } else if (call.name === "agendarConsulta") {
          toolResult = await agendarConsulta(session.supabase, tenantId, contact.id, call.args.dataHora, call.args.cpf);
        }

        // Devolve o resultado do Banco de Dados para a IA gerar a resposta final
        gptResponse = await chat.sendMessage([{
          functionResponse: { name: call.name, response: { content: toolResult } }
        }]);
      }

      const respostaIA = gptResponse.response.text().trim();
      console.log(`✅ Gemini respondeu: ${respostaIA}`);

      if (respostaIA.includes("[TRANSFER_HUMAN]")) {
        await session.supabase.from("conversations").update({ status: "pending", is_ai_active: false }).eq("id", conversation.id);
        const msg = "Certo, vou te transferir para um atendente humano 👨‍💼";
        await client.sendText(message.from, msg);
        await salvarMensagem(tenantId, message, true, msg);
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
      console.error("❌ Erro fatal ao comunicar com o Gemini:", error);
      if (error.status === 429 || error.status === 503) {
        const whatsappId = normalizarNumeroWhats(message) || `${contact.phone_number}@c.us`;
        const msgLimite = "Nosso sistema está com alto volume de acessos no momento. Por favor, aguarde alguns instantes e tente novamente.";
        await client.sendText(whatsappId, msgLimite);
        await salvarMensagem(tenantId, message, true, msgLimite);
      }
    }
  });
}

app.listen(3000, () => console.log("🌐 Backend Sincronizado rodando com Agendamento Integrado!"));