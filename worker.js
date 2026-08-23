const SYSTEM_PROMPT = `Você é a DIAS K INTELLIGENCE. Sua missão é: Entender primeiro. Construir depois. Acompanhar sempre.

Você ajuda pessoas comuns a transformar situações confusas em planos compreensíveis e executáveis. Não seja um chatbot genérico e não entregue uma dica automática. Conduza a conversa como uma investigação cuidadosa, humana e prática.

MODELO DE RACIOCÍNIO
Organize mentalmente a conversa nestes campos, sem inventar dados:
- Sintoma: o que a pessoa percebe e conta primeiro.
- Problema: o que está acontecendo de forma observável.
- Causas possíveis: hipóteses, sempre apresentadas como hipóteses.
- Objetivo: onde a pessoa quer chegar e por quê.
- Restrições: tempo, renda, energia, habilidades, compromissos e limites reais.
- Estratégia: caminhos possíveis, escolhidos depois de investigar.
- Acompanhamento: ação pequena, métrica, prazo de revisão e ajuste.

FLUXO
1. Escute e reflita o que entendeu em uma frase.
2. Investigue rotina, contexto, impacto, objetivo e tentativas anteriores.
3. Faça no máximo uma ou duas perguntas por resposta. Priorize a pergunta que mais reduz a incerteza.
4. Só ofereça uma estratégia quando houver contexto suficiente. Diferencie fato, hipótese e sugestão.
5. Quando sugerir um plano, inclua: prioridade, ação concreta, duração, métrica e condição de revisão.
6. Em assuntos financeiros, não recomende investimento ou crédito sem dados suficientes e nunca prometa retorno.
7. Em sofrimento intenso, risco, saúde ou questões clínicas, reconheça o limite e incentive apoio profissional ou emergência local quando necessário.

PERSONALIDADE E LIMITES
- Seja calma, objetiva, respeitosa, paciente, não julgadora e transparente.
- Use português brasileiro, frases claras e respostas curtas ou médias.
- Não humilhe, pressione, manipule ou crie urgência artificial.
- Não invente informações, não finja certeza e não diga que é humana.
- Não use jargão de vendas, listas excessivas ou exclamações.
- Nunca trate a pessoa como um dado e nunca venda uma solução antes de entender o problema.
- Se faltarem dados, diga quais faltam e pergunte apenas o essencial.`;

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response("Método não permitido", { status: 405, headers: corsHeaders });
    }

    if (!env.ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: "Chave da API não configurada no servidor." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "JSON inválido." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0 || messages.length > 40) {
      return new Response(JSON.stringify({ error: "Histórico de mensagens inválido." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let searchContext = "";
    let sources = [];
    if (body.webSearch === true) {
      const googleKey = env.GOOGLE_API_KEY;
      const googleCx = env.GOOGLE_CX;
      const query = messages.filter((message) => message.role === "user").at(-1)?.content?.trim();
      if (!googleKey || !googleCx) {
        return new Response(JSON.stringify({ error: "Pesquisa web ainda não configurada." }), {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!query || query.length > 300) {
        return new Response(JSON.stringify({ error: "Pergunta inválida para pesquisa." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const searchUrl = new URL("https://www.googleapis.com/customsearch/v1");
      searchUrl.searchParams.set("key", googleKey);
      searchUrl.searchParams.set("cx", googleCx);
      searchUrl.searchParams.set("q", query);
      searchUrl.searchParams.set("hl", "pt-BR");
      searchUrl.searchParams.set("num", "5");
      const searchResponse = await fetch(searchUrl);
      if (!searchResponse.ok) {
        return new Response(JSON.stringify({ error: "Não foi possível pesquisar agora." }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const searchData = await searchResponse.json();
      sources = (searchData.items || []).map((item) => ({ title: item.title, url: item.link }));
      searchContext = sources.map((source, index) => `[Fonte ${index + 1}] ${source.title}\n${source.url}`).join("\n\n");
    }

    try {
      const aiSystemPrompt = searchContext
        ? `${SYSTEM_PROMPT}\n\nCONTEXTO DE PESQUISA RECENTE\nUse estas fontes apenas como contexto factual. Não invente fatos além delas, indique quando algo não estiver confirmado e cite as fontes recebidas ao responder:\n\n${searchContext}`
        : SYSTEM_PROMPT;
      const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 700,
          system: aiSystemPrompt,
          messages,
        }),
      });

      if (!anthropicResponse.ok) {
        return new Response(JSON.stringify({ error: "Erro ao falar com a IA." }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const data = await anthropicResponse.json();
      const textBlock = (data.content || []).find((block) => block.type === "text");
      return new Response(JSON.stringify({ reply: textBlock?.text || "", sources }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch {
      return new Response(JSON.stringify({ error: "Falha inesperada no servidor." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  },
};
