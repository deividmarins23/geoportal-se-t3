# GEOPORTAL SE-T3

WebGIS local/publicado para visualização de ortomosaico(s) e vegetação classificada,
organizados por **projeto** e por **data do voo** de drone.

Publicado em: https://deividmarins23.github.io/geoportal-se-t3/

## Como abrir localmente

Duplo-clique em `RUN_GEOPORTAL.bat` (ou `python server.py` no terminal). O navegador abre
automaticamente em `http://localhost:8765/static/index.html`.

Ortofoto e vegetação funcionam offline — só as camadas de mapa base "Satélite (Esri)" e
"OpenStreetMap" precisam de internet.

## Como adicionar um voo novo (mesmo projeto ou projeto novo)

```
python build_data.py --project <slug> --project-name "<Nome de exibição>" --date <AAAA-MM-DD> ^
    --src-geojson "<caminho do geojson de vegetação deste voo>" ^
    --src-tif "<caminho da ortofoto deste voo>"
```

Exemplo (reprocessando o voo atual da SE-T3):
```
python build_data.py --project se-t3 --project-name "SE-T3" --date 2026-08-03
```
(`--src-geojson`/`--src-tif` são opcionais quando os arquivos já estão nos caminhos padrão,
na pasta acima de `geoportal\`.)

Isso gera:
- `data/<projeto>/<data>/vegetacao_4326.geojson` — vegetação simplificada e reprojetada
- `data/<projeto>/<data>/tiles/{z}/{x}/{y}.webp` — pirâmide de tiles da ortofoto (zoom 15–21)
- `data/<projeto>/<data>/meta.json` — bounds e contagem/área por classe desse voo
- `data/catalog.json` — reconstruído automaticamente no fim, listando todos os projetos/voos

Use `--skip-vector` ou `--skip-raster` para regenerar só uma parte de um voo já existente.
Use `python build_data.py --catalog-only` se mexeu/apagou uma pasta de voo manualmente e só
precisa reconstruir o índice.

Depois de gerar, publique:
```
git add .
git commit -m "novo voo: <projeto> <data>"
git push
```
O GitHub Pages atualiza o site em ~1 minuto.

## Como o app usa o catálogo

O frontend (`static/js/app.js`) lê `data/catalog.json` e monta um cartão por projeto na
barra lateral: seletor de voo (data), checkbox de ortofoto (carrega os tiles sob demanda,
só quando ligado) e as 5 camadas de vegetação (Solo, Roço, Poda Leve, Poda Seletiva, Não
Identificado), cada uma com cor e opacidade próprias. Vários projetos podem ficar ligados ao
mesmo tempo — cada um cuida da própria ortofoto e vegetação de forma independente. A
ferramenta "Comparar Ortofotos" (swipe) compara duas ortofotos quaisquer do catálogo (de
projetos e/ou datas diferentes) lado a lado com uma barra deslizante.

## Estrutura

```
geoportal/
  build_data.py      pré-processamento por voo (ver "Como adicionar um voo novo")
  server.py          servidor local estático
  RUN_GEOPORTAL.bat  atalho de duplo-clique
  data/              gerado por build_data.py (não editar à mão)
    catalog.json
    <projeto>/<data>/{meta.json, vegetacao_4326.geojson, tiles/}
  static/            frontend (Leaflet + HTML/CSS/JS)
```
