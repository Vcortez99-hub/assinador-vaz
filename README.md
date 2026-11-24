# Assinador Vaz

Assinatura eletrônica de documentos por link, sem cadastro.

- `preparar.html` — envie o PDF, informe quem assina, marque o lugar da assinatura e gere o link.
- `index.html#<id>.<chave>` — quem recebe o link lê o documento, confirma o CPF, desenha a rubrica e devolve o PDF assinado.

Os documentos ficam em `e/` cifrados com AES-256-GCM. A chave existe só no link (depois do `#`), que nunca é enviado ao servidor.
As assinaturas entram no PDF por atualização incremental, preservando assinaturas digitais já existentes (ex.: ICP-Brasil).
