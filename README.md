# GEOPORTAL SE-T3

WebGIS local para visualização do ortomosaico e da vegetação classificada da SE-T3.

## Como abrir

Duplo-clique em `RUN_GEOPORTAL.bat` (ou `python server.py` no terminal). O navegador abre
automaticamente em `http://localhost:8765/static/index.html`.

Não precisa de internet para ver a ortofoto e a vegetação — só as camadas de mapa base
"Satélite (Esri)" e "OpenStreetMap" precisam de conexão.

## Como regenerar os dados

Se `ORTO_WEBGIS.tif` ou `VEGETAÇÃO CLASSIFICADA.geojson` (na pasta acima, `..\`) forem
atualizados, rode novamente:

```
python build_data.py
```

Isso recria:
- `data/vegetacao_4326.geojson` — vegetação simplificada e reprojetada para EPSG:4326
- `data/tiles/{z}/{x}/{y}.png` — pirâmide de tiles da ortofoto (zoom 15–21, EPSG:3857)

Use `--skip-vector` ou `--skip-raster` para regenerar só uma das partes.

## Estrutura

```
geoportal/
  build_data.py      pré-processamento (rodar 1x ou quando os dados mudarem)
  server.py          servidor local estático
  RUN_GEOPORTAL.bat  atalho de duplo-clique
  data/              gerado por build_data.py (não editar à mão)
  static/            frontend (Leaflet + HTML/CSS/JS)
```
