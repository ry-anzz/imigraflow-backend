require('dotenv').config();
const express = require('express');
const cors = require('cors');
const wppconnect = require('@wppconnect-team/wppconnect');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURAÇÃO ---
const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_KEY;
const openaiKey = process.env.OPENAI_API_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ ERRO: Faltam chaves no .env');
    process.exit(1);
}

const openai = new OpenAI({ apiKey: openaiKey });

// --- MEMÓRIA DE SESSÕES ---
// { 'tenant_id': { status: '...', qr: '...', client: ..., supabase: ... } }
const SESSIONS = {}; 

// --- HELPER: Descobre quem é o usuário pelo Token ---
async function getTenantFromToken(authHeader) {
    if (!authHeader) return null;
    const token = authHeader.split(' ')[1];

    // Cria um cliente Supabase temporário com o crachá do usuário
    const supabaseUser = createClient(supabaseUrl, supabaseKey, {
        global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { data: { user } } = await supabaseUser.auth.getUser();
    if (!user) return null;

    // Busca o ID da empresa desse usuário
    const { data: profile } = await supabaseUser
        .from('profiles')
        .select('tenant_id')
        .eq('id', user.id)
        .maybeSingle();

    if (!profile) return null;

    return { 
        tenantId: profile.tenant_id, 
        email: user.email, 
        supabase: supabaseUser // Retorna o cliente autenticado pra gente usar depois
    };
}

// --- ROTA 1: INICIAR ---
app.post('/iniciar', async (req, res) => {
    // 1. Identifica o usuário pelo Token
    const userSession = await getTenantFromToken(req.headers.authorization);
    
    if (!userSession) {
        return res.status(401).json({ erro: 'Token inválido ou expirado.' });
    }

    const { tenantId, email, supabase } = userSession;
    console.log(`📢 Iniciando Tenant: ${tenantId} (${email})`);

    // 2. Se já existe sessão ativa, atualiza o token do banco e retorna
    if (SESSIONS[tenantId] && SESSIONS[tenantId].client) {
        SESSIONS[tenantId].supabase = supabase; // Atualiza o cliente para não expirar
        return res.json({ mensagem: 'Sessão atualizada', status: SESSIONS[tenantId].status });
    }

    // 3. Cria nova sessão na memória
    SESSIONS[tenantId] = { 
        status: 'INICIANDO', 
        qr: null, 
        client: null,
        supabase: supabase 
    };

    iniciarWPP(tenantId);
    res.json({ mensagem: 'Inicializando...' });
});

// --- ROTA 2: STATUS (Agora filtrado por Tenant!) ---
app.get('/status', async (req, res) => {
    // 1. Descobre quem está perguntando
    const userSession = await getTenantFromToken(req.headers.authorization);

    // Se não logou ou não achou tenant, retorna desconectado
    if (!userSession) {
        return res.json({ status: 'DESCONECTADO', qrcode: null });
    }

    const { tenantId } = userSession;
    
    // 2. Retorna SÓ o status da empresa desse usuário
    const session = SESSIONS[tenantId] || { status: 'DESCONECTADO', qr: null };
    
    res.json({ status: session.status, qrcode: session.qr });
});

// --- ROTA 3: ENVIAR MENSAGEM (Do Inbox) ---
app.post('/send-message', async (req, res) => {
    const { conversationId, content } = req.body;
    
    // Identifica o usuário para saber qual robô usar
    const userSession = await getTenantFromToken(req.headers.authorization);
    if (!userSession) return res.status(401).json({ erro: 'Não autorizado' });

    const { tenantId, supabase } = userSession;
    const session = SESSIONS[tenantId];
    
    if (!session || !session.client) {
        return res.status(400).json({ erro: 'Robô desconectado.' });
    }

    try {
        const { data: conversation } = await supabase
            .from('conversations')
            .select('phone_number')
            .eq('id', conversationId)
            .single();

        if (conversation) {
            await session.client.sendText(conversation.phone_number, content);
            res.json({ success: true });
        } else {
            res.status(404).json({ erro: 'Conversa não encontrada.' });
        }
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

// --- FUNÇÃO DE SALVAR (Versão Camaleão 🦎) ---
async function salvarMensagem(tenantId, message, fromMe = false, content = '') {
    const session = SESSIONS[tenantId];
    if (!session || !session.supabase) {
        console.error(`❌ Erro: Sessão ${tenantId} sem credenciais.`);
        return null;
    }

    const sb = session.supabase;
    const phone = message.from || message.to;
    const name = message.notifyName || phone;
    const body = content || message.body;

    try {
        // 1. Contato
        let { data: contact } = await sb.from('contacts')
            .select('id').eq('tenant_id', tenantId).eq('phone_number', phone).maybeSingle();

        if (!contact) {
            const { data: newContact, error } = await sb.from('contacts')
                .insert({ tenant_id: tenantId, phone_number: phone, name: name })
                .select().single();
            if (error) { console.error('❌ Erro Contato:', error.message); return null; }
            contact = newContact;
        }

        // 2. Conversa
        let { data: conversation } = await sb.from('conversations')
            .select('*').eq('tenant_id', tenantId).eq('contact_id', contact.id).eq('status', 'active').maybeSingle();

        if (!conversation) {
            const { data: newConv, error } = await sb.from('conversations')
                .insert({ 
                    tenant_id: tenantId, 
                    contact_id: contact.id, 
                    phone_number: phone, 
                    status: 'active',
                    is_ai_active: true,
                    provider: 'meta' // <--- CAMALEÃO
                }).select().single();

            if (error) { console.error('❌ Erro Conversa:', error.message); return null; }
            conversation = newConv;
        }

        // 3. Mensagem
        const { error: msgError } = await sb.from('messages').insert({
            conversation_id: conversation.id,
            tenant_id: tenantId,
            sender_type: fromMe ? 'ai' : 'customer',
            content: body,
            message_type: 'text',
            provider: 'meta', // <--- CAMALEÃO
            is_read: fromMe
        });

        if (msgError) console.error('❌ Erro Mensagem:', msgError.message);

        // 4. Atualizar Conversa
        await sb.from('conversations').update({
            last_message: body,
            last_message_at: new Date().toISOString(),
            unread_count: fromMe ? 0 : (conversation.unread_count || 0) + 1
        }).eq('id', conversation.id);

        return conversation;

    } catch (e) {
        console.error('Erro salvar:', e);
        return null;
    }
}

// --- WPPCONNECT (Sessões Isoladas) ---
async function iniciarWPP(tenantId) {
    try {
        console.log(`🚀 Iniciando Worker para: ${tenantId}`);
        await wppconnect.create({
            session: tenantId, // Nome único para a pasta
            catchQR: (base64Qr) => {
                if (SESSIONS[tenantId]) { 
                    console.log(`✅ QR Code gerado para ${tenantId}`);
                    SESSIONS[tenantId].qr = base64Qr; 
                    SESSIONS[tenantId].status = 'QRCODE'; 
                }
            },
            statusFind: (status) => {
                console.log(`Status ${tenantId}: ${status}`);
                if (SESSIONS[tenantId] && (status === 'inChat' || status === 'isLogged')) {
                    SESSIONS[tenantId].status = 'CONECTADO';
                    SESSIONS[tenantId].qr = null;
                }
            },
            headless: true,
            logQR: false,
            // Importante para não travar pastas
            puppeteerOptions: { userDataDir: `./tokens/${tenantId}/.data` }
        }).then((client) => {
            if (SESSIONS[tenantId]) {
                SESSIONS[tenantId].client = client;
                start(client, tenantId);
            }
        });
    } catch (e) { 
        console.error(`Erro WPP ${tenantId}:`, e);
        if (SESSIONS[tenantId]) SESSIONS[tenantId].status = 'ERRO'; 
    }
}

// --- CÉREBRO ---
function start(client, tenantId) {
    console.log(`🤖 Robô Ativo: ${tenantId}`);

    client.onMessage(async (message) => {
        if (message.isGroupMsg || message.fromMe || message.from === 'status@broadcast') return;
        
        console.log(`📩 [${tenantId}] Msg: ${message.body}`);
        const session = SESSIONS[tenantId];

        if (!session || !session.supabase) return;

        // 1. SALVAR
        const conversation = await salvarMensagem(tenantId, message);
        if (!conversation || !conversation.is_ai_active) return;

        try {
            // 2. CONFIG IA
            const { data: aiConfig } = await session.supabase
                .from('ai_configurations')
                .select('*')
                .eq('tenant_id', tenantId)
                .maybeSingle();

            let systemPrompt = aiConfig?.system_prompt || 'Você é um assistente.';
            if (aiConfig?.business_name) systemPrompt += `\nEmpresa: ${aiConfig.business_name}`;
            
            // (Adicione aqui a lógica de serviços/horários se quiser)

            const gptResponse = await openai.chat.completions.create({
                model: "gpt-3.5-turbo",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: message.body }
                ]
            });

            const resposta = gptResponse.choices[0].message.content;
            await client.sendText(message.from, resposta);
            
            // Salva resposta
            await salvarMensagem(tenantId, message, true, resposta);

        } catch (error) {
            console.error('Erro IA:', error);
        }
    });
}

app.listen(3000, () => console.log('🌐 Servidor Multi-Empresa Corrigido (3000)'));