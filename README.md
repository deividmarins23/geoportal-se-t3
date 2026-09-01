# GEOPORTAL

WebGIS local/publicado, multi-projeto, para visualização de ortomosaico(s) e vegetação
classificada de voos de drone. Um projeto pode ter só ortofoto, só vegetação, ou os dois; e
pode (opcionalmente) ser dividido em **blocos/subcampos** (ex: uma usina solar com vários
campos, carregados aos poucos conforme os voos vão sendo feitos).

Publicado em: https://deividmarins23.github.io/geoportal-se-t3/

## Como abrir localmente

Duplo-clique em `RUN_GEOPORTAL.bat` (ou `python server.py` no terminal). O navegador abre
automaticamente em `http://localhost:8765/static/index.html`.

Ortofoto e vegetação funcionam offline — só as camadas de mapa base "Satélite (Esri)" e
"OpenStreetMap" precisam de internet.

## Como adicionar dados (jeito fácil — interface gráfica)

Duplo-clique em `GEOPORTAL_GERENCIADOR.bat`. Abre uma janela (sem terminal) com:
- uma lista do que já está carregado (projeto, bloco, data, se tem ortofoto/vegetação);
- um formulário pra adicionar um item novo: nome do projeto (escolhe um já existente na lista
  ou digita um novo), bloco/subcampo (opcional), data do voo, e botões "Procurar..." pra
  selecionar os arquivos (geojson de vegetação e/ou ortofoto — pode ter só um dos dois, sem
  precisar digitar caminho nenhum);
- uma caixa de "Andamento" mostrando o progresso em tempo real;
- um botão "Publicar agora" (ou a opção de publicar automaticamente depois de cada item).

Pensada pra quem não mexe com linha de comando. **Importante pro caso de projetos com muitos
blocos** (ex: usina solar com 20 subcampos): processar um subcampo novo **não mexe** nos que já
estavam carregados — cada um vive na sua própria pasta e só é reprocessado se você apontar pra
ele de novo.

## Como adicionar dados (linha de comando, pra automatizar)

```
python build_data.py --project <slug> --project-name "<Nome de exibição>" --date <AAAA-MM-DD> ^
    [--block <NomeDoBloco>] ^
    [--src-geojson "<geojson de vegetação>"] [--src-tif "<ortofoto>"]
```
Pelo menos um dos dois `--src-*` precisa ser informado. Exemplo (voo da SE-T3, sem blocos):
```
python build_data.py --project se-t3 --project-name "SE-T3" --date 2026-08-03 ^
    --src-geojson "..\VEGETAÇAO CLASSIFICADA.geojson" --src-tif "..\ORTO_WEBGIS.tif"
```
Exemplo (subcampo de uma usina solar, só ortofoto por enquanto):
```
python build_data.py --project usina-boa-vista --project-name "Usina Boa Vista" --date 2026-09-10 ^
    --block PCS01 --src-tif "caminho\ortofoto_pcs01.tif"
```

Isso gera, por item processado:
- `data/<projeto>/<data ou data--bloco>/vegetacao_4326.geojson` (se houver `--src-geojson`)
- `data/<projeto>/<data ou data--bloco>/tiles/{z}/{x}/{y}.webp` (se houver `--src-tif`, zoom 15–21)
- `data/<projeto>/<data ou data--bloco>/meta.json` — bounds, flags de quais camadas existem e
  contagem/área por classe

`data/catalog.json` é reconstruído automaticamente no fim (varrendo todos os `meta.json` que já
existem em disco) — **nunca reprocessa** o que já estava lá, só agrega o que encontrar.

Use `--skip-vector` ou `--skip-raster` pra regenerar só uma parte de um item já existente. Use
`python build_data.py --catalog-only` se mexeu/apagou uma pasta manualmente e só precisa
reconstruir o índice.

Depois de gerar, publique:
```
git add .
git commit -m "novo item: <projeto>/<bloco> <data>"
git push
```
O GitHub Pages atualiza o site em ~1 minuto.

## Como o app usa o catálogo

O frontend (`static/js/app.js`) lê `data/catalog.json` e monta:
- Um **seletor de projeto** na barra lateral — escolher um projeto mostra o painel dele
  (não desliga o que já estava ativo em outro projeto).
- Se o projeto tiver **blocos**: uma grade de botões (um por bloco) com "selecionar todos" —
  clicar liga/desliga a ortofoto+vegetação daquele bloco no mapa (usa sempre a data mais
  recente daquele bloco).
- Se o projeto **não** tiver blocos: um seletor de data de voo + um checkbox "Ativar" (mesmo
  comportamento de antes).
- Ortofoto só aparece como opção se aquele item realmente tiver ortofoto; vegetação só aparece
  se tiver vegetação — um projeto pode ter só uma das duas.
- Uma **legenda de vegetação global** (cor + opacidade por classe), compartilhada por todos os
  projetos/blocos ativos ao mesmo tempo — ligar/desligar ou recolorir uma classe afeta todo
  mundo que estiver mostrando aquela classe no momento.
- A ferramenta "Comparar Camadas" (swipe) compara duas camadas quaisquer do catálogo lado a
  lado com uma barra deslizante — ortofoto ou vegetação, de projetos/blocos/datas diferentes,
  em qualquer combinação (ex: ortofoto vs. ortofoto, vegetação vs. vegetação, ou até ortofoto
  vs. vegetação).

Tiles e GeoJSON só são buscados na primeira vez que algo é ligado (lazy) e ficam em cache no
navegador pro resto da sessão — desligar e religar não refaz o download.

## Estrutura

```
geoportal/
  build_data.py               pré-processamento por item (projeto+data[+bloco])
  geoportal_ui.py              interface gráfica (chamada pelo .bat abaixo)
  server.py                    servidor local estático
  RUN_GEOPORTAL.bat            abre o site localmente
  GEOPORTAL_GERENCIADOR.bat    interface gráfica pra carregar novos projetos/blocos/voos
  data/                        gerado por build_data.py (não editar à mão)
    catalog.json
    <projeto>/<data ou data--bloco>/{meta.json, vegetacao_4326.geojson, tiles/}
  static/                      frontend (Leaflet + HTML/CSS/JS)
```
