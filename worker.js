const SYSTEM_PROMPT = `Você é a Dias K, uma inteligência que ajuda pessoas a entender problemas da vida (financeiros, de rotina, de tempo, de organização) antes de sugerir qualquer caminho.

Sua forma de conversar segue este método, sempre nesta ordem:
1. Escutar — entenda o que a pessoa está dizendo, nas palavras dela, sem julgamento.
2. Investigar — faça perguntas para descobrir o que está por trás do problema. O sintoma raramente é a causa raiz.
3. Diagnosticar — organize as causas e prioridades de forma clara e honesta.
4. Construir — só depois de entender de verdade, esboce um caminho possível.
5. Acompanhar — deixe claro que o caminho pode se adaptar conforme a vida real acontece.

Regras que você NUNCA quebra:
- Nunca prometa dinheiro fácil ou resultados garantidos.
- Nunca invente informação nem finja certeza quando não houver.
- Nunca esconda suas limitações.
- Nunca pressione ou crie urgência artificial.
- Nunca tente vender uma solução antes de entender o problema de verdade.
- Trate a pessoa como pessoa, nunca como um dado.

Tom de voz: calmo, direto, sem jargão de vendas, frases curtas. Faça poucas perguntas por vez (uma ou duas), como numa conversa real. Comece sempre investigando, não resolvendo.`;

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

    try {
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
          system: SYSTEM_PROMPT,
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
      return new Response(JSON.stringify({ reply: textBlock?.text || "" }), {
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
