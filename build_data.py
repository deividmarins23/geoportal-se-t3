# -*- coding: utf-8 -*-
"""
Pre-processamento do GEOPORTAL (multi-projeto).

Processa UM item (projeto + data, opcionalmente + bloco/subcampo) por chamada de
process_flight()/execucao de CLI:
  1. Se houver GeoJSON de vegetacao (EPSG:32724): simplifica e reprojeta para
     EPSG:4326, gravando .../vegetacao_4326.geojson.
  2. Se houver ortofoto (RGBA): gera piramide de tiles XYZ (EPSG:3857) em WebP
     em .../tiles/{z}/{x}/{y}.webp.
  3. Grava .../meta.json (bounds, flags hasOrtho/hasVegetation, contagem/area por classe).
  4. Reconstroi data/catalog.json varrendo todos os meta.json existentes -- isso
     NUNCA reprocessa itens ja existentes, so agrega o que ja esta no disco.

Um "item" pode ter so vegetacao, so ortofoto, ou os dois -- pelo menos um dos
--src-geojson / --src-tif precisa ser passado.

Uso (linha de comando):
    python build_data.py --project se-t3 --project-name "SE-T3" --date 2026-08-03 ^
        [--block PCS01] [--src-geojson "...\\veg.geojson"] [--src-tif "...\\orto.tif"]

Para so reconstruir o catalogo (depois de mexer/remover uma pasta a mao):
    python build_data.py --catalog-only

Para adicionar varios projetos/blocos de forma guiada, sem decorar esses
parametros, use o assistente interativo: ingest_wizard.py (ou ADICIONAR_DADOS.bat).
"""
import argparse
import glob
import json
import math
import os
import re
import time

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from rasterio.windows import from_bounds
from PIL import Image
from pyproj import Transformer
from shapely.geometry import shape, mapping

WEBGIS_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(WEBGIS_DIR, "data")
CATALOG_PATH = os.path.join(DATA_DIR, "catalog.json")

SIMPLIFY_TOLERANCE_M = 0.20  # metros, aplicado em UTM antes de reprojetar
MIN_ZOOM = 15
MAX_ZOOM = 21
TILE_SIZE = 256
TILE_EXT = "webp"

# id -> nome de exibicao da classe, usado so pra montar o resumo em meta.json
# (o app.js tem sua propria copia, com as cores; aqui e so pra estatistica).
# Se aparecer uma classe fora dessa lista, usa "Classe <id>" automaticamente --
# nao precisa editar isso pra novos projetos com outra legenda.
CLASS_NAMES = {
    1: "Solo",
    2: "Roço (até 0,40 m)",
    3: "Poda Leve (0,40 m a 3,00 m)",
    4: "Poda Seletiva (3,00 m a 8,00 m)",
    6: "Não Identificado",
}

WEB_MERCATOR_R = 6378137.0
WEB_MERCATOR_ORIGIN = math.pi * WEB_MERCATOR_R  # 20037508.342789244


def log(msg):
    print(f"[build_data] {msg}", flush=True)


def slugify(text):
    text = text.strip().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-") or "item"


def flight_folder_name(date, block=None):
    return date if not block else f"{date}--{slugify(block)}"


def flight_dir(project, date, block=None):
    return os.path.join(DATA_DIR, slugify(project), flight_folder_name(date, block))


# ----------------------------------------------------------------------
# 1. Vetor: simplifica + reprojeta
# ----------------------------------------------------------------------
def build_vector(src_geojson, out_dir):
    log(f"Lendo {src_geojson} ...")
    t0 = time.time()
    with open(src_geojson, "r", encoding="utf-8") as f:
        data = json.load(f)

    src_size = os.path.getsize(src_geojson)
    transformer = Transformer.from_crs("EPSG:32724", "EPSG:4326", always_xy=True)

    out_features = []
    class_stats = {}  # classe_id -> {count, area_m2}
    bbox = [None, None, None, None]  # minx, miny, maxx, maxy (WGS84)

    for feat in data["features"]:
        geom = shape(feat["geometry"])
        # simplifica em UTM (metros) para remover ruido de vetorizacao de raster
        geom = geom.simplify(SIMPLIFY_TOLERANCE_M, preserve_topology=True)
        if geom.is_empty:
            continue

        # reprojeta para WGS84
        geom = shapely_transform(geom, transformer)

        gminx, gminy, gmaxx, gmaxy = geom.bounds
        bbox[0] = gminx if bbox[0] is None else min(bbox[0], gminx)
        bbox[1] = gminy if bbox[1] is None else min(bbox[1], gminy)
        bbox[2] = gmaxx if bbox[2] is None else max(bbox[2], gmaxx)
        bbox[3] = gmaxy if bbox[3] is None else max(bbox[3], gmaxy)

        props = feat.get("properties", {})
        classe_id = props.get("classe_id")
        area_m2 = float(props.get("area_m2") or 0)

        st = class_stats.setdefault(classe_id, {"count": 0, "areaM2": 0.0})
        st["count"] += 1
        st["areaM2"] += area_m2

        out_features.append({
            "type": "Feature",
            "properties": {
                "classe_id": classe_id,
                "classe_nome": props.get("classe_nome"),
                "rotulo": props.get("rotulo"),
                "area_m2": props.get("area_m2"),
            },
            "geometry": mapping(geom),
        })

    out = {
        "type": "FeatureCollection",
        "name": "vegetacao_4326",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": out_features,
    }

    out_path = os.path.join(out_dir, "vegetacao_4326.geojson")
    os.makedirs(out_dir, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)

    out_size = os.path.getsize(out_path)
    log(f"Vegetacao: {len(out_features)} feicoes | {src_size/1e6:.1f} MB -> {out_size/1e6:.1f} MB "
        f"| {time.time()-t0:.1f}s")

    classes = []
    for cid, st in sorted(class_stats.items(), key=lambda kv: (kv[0] is None, kv[0])):
        classes.append({
            "id": cid,
            "name": CLASS_NAMES.get(cid, f"Classe {cid}"),
            "count": st["count"],
            "areaM2": round(st["areaM2"], 2),
        })

    bounds_4326 = tuple(bbox) if bbox[0] is not None else None  # (left, bottom, right, top)
    return classes, bounds_4326


def shapely_transform(geom, transformer):
    from shapely.ops import transform as shp_transform
    return shp_transform(lambda x, y, z=None: transformer.transform(x, y), geom)


# ----------------------------------------------------------------------
# 2. Raster: piramide de tiles XYZ (EPSG:3857), formato WebP
# ----------------------------------------------------------------------
def tile_bounds_merc(z, x, y):
    n = 2 ** z
    tile_size_m = 2 * WEB_MERCATOR_ORIGIN / n
    minx = -WEB_MERCATOR_ORIGIN + x * tile_size_m
    maxx = minx + tile_size_m
    maxy = WEB_MERCATOR_ORIGIN - y * tile_size_m
    miny = maxy - tile_size_m
    return minx, miny, maxx, maxy


def merc_to_tile_xy(z, mx, my):
    n = 2 ** z
    tile_size_m = 2 * WEB_MERCATOR_ORIGIN / n
    x = int((mx + WEB_MERCATOR_ORIGIN) / tile_size_m)
    y = int((WEB_MERCATOR_ORIGIN - my) / tile_size_m)
    return x, y


def build_raster(src_tif, out_dir):
    log(f"Abrindo {src_tif} ...")
    t0 = time.time()
    out_tiles = os.path.join(out_dir, "tiles")

    with rasterio.open(src_tif) as src:
        bounds_4326 = tuple(src.bounds)  # (left, bottom, right, top), ja em EPSG:4326

        with WarpedVRT(src, crs="EPSG:3857", resampling=Resampling.bilinear) as vrt:
            left, bottom, right, top = vrt.bounds
            log(f"Bounds (EPSG:3857): {left:.1f}, {bottom:.1f}, {right:.1f}, {top:.1f}")

            total_tiles = 0
            written_tiles = 0
            for z in range(MIN_ZOOM, MAX_ZOOM + 1):
                x0, y0 = merc_to_tile_xy(z, left, top)
                x1, y1 = merc_to_tile_xy(z, right, bottom)
                xs = range(min(x0, x1), max(x0, x1) + 1)
                ys = range(min(y0, y1), max(y0, y1) + 1)

                z_written = 0
                for x in xs:
                    for y in ys:
                        total_tiles += 1
                        minx, miny, maxx, maxy = tile_bounds_merc(z, x, y)
                        window = from_bounds(minx, miny, maxx, maxy, transform=vrt.transform)
                        try:
                            data = vrt.read(
                                out_shape=(vrt.count, TILE_SIZE, TILE_SIZE),
                                window=window,
                                resampling=Resampling.bilinear,
                            )
                        except Exception:
                            continue

                        if data.shape[0] < 4:
                            continue
                        alpha = data[3]
                        if not np.any(alpha):
                            continue  # tile totalmente transparente, pula

                        arr = np.moveaxis(data[:4], 0, -1)
                        img = Image.fromarray(arr, mode="RGBA")

                        tile_dir = os.path.join(out_tiles, str(z), str(x))
                        os.makedirs(tile_dir, exist_ok=True)
                        img.save(
                            os.path.join(tile_dir, f"{y}.{TILE_EXT}"),
                            "WEBP", quality=85, method=6,
                        )
                        written_tiles += 1
                        z_written += 1
                log(f"  zoom {z}: {z_written} tiles gravados")

    dur = time.time() - t0
    log(f"Raster: {written_tiles}/{total_tiles} tiles gravados em {dur:.1f}s")

    size = 0
    for root, _, files in os.walk(out_tiles):
        for fn in files:
            size += os.path.getsize(os.path.join(root, fn))
    log(f"Tamanho total tiles ({TILE_EXT}): {size/1e6:.1f} MB")

    return bounds_4326


# ----------------------------------------------------------------------
# 3. meta.json por item + catalog.json agregado
# ----------------------------------------------------------------------
def write_flight_meta(out_dir, project, project_name, date, block, bounds_4326,
                       has_ortho, has_vegetation, classes):
    left, bottom, right, top = bounds_4326
    meta = {
        "project": project,
        "projectName": project_name,
        "date": date,
        "block": block,  # None para projetos sem subdivisao em blocos/subcampos
        "bounds": [[bottom, left], [top, right]],  # [[south, west], [north, east]]
        "hasOrtho": has_ortho,
        "hasVegetation": has_vegetation,
        "tileExt": TILE_EXT,
        "minNativeZoom": MIN_ZOOM,
        "maxNativeZoom": MAX_ZOOM,
        "classes": classes,
    }
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
    return meta


def process_flight(project, project_name, date, block=None,
                    src_geojson=None, src_tif=None,
                    skip_vector=False, skip_raster=False):
    """
    Processa um unico item (projeto+data[+bloco]) e grava seu meta.json.
    NAO reconstroi o catalogo -- chame rebuild_catalog() depois de processar
    todos os itens de uma leva (assim projetos com muitos blocos nao re-escrevem
    o catalogo N vezes a toa). Retorna o caminho da pasta gravada.
    """
    if not src_geojson and not src_tif:
        raise ValueError("informe --src-geojson e/ou --src-tif (pelo menos um dos dois)")

    project_slug = slugify(project)
    out_dir = flight_dir(project, date, block)
    os.makedirs(out_dir, exist_ok=True)
    label = project_name + (f" / {block}" if block else "") + f" ({date})"
    log(f"=== Processando {label} -> {out_dir} ===")

    classes = []
    veg_bounds = None
    has_vegetation = bool(src_geojson)
    if has_vegetation and not skip_vector:
        classes, veg_bounds = build_vector(src_geojson, out_dir)
    elif has_vegetation:
        meta_path = os.path.join(out_dir, "meta.json")
        if os.path.exists(meta_path):
            with open(meta_path, "r", encoding="utf-8") as f:
                old = json.load(f)
            classes = old.get("classes", [])

    has_ortho = bool(src_tif)
    ortho_bounds = None
    if has_ortho and not skip_raster:
        ortho_bounds = build_raster(src_tif, out_dir)
    elif has_ortho:
        meta_path = os.path.join(out_dir, "meta.json")
        if os.path.exists(meta_path):
            with open(meta_path, "r", encoding="utf-8") as f:
                b = json.load(f)["bounds"]
            ortho_bounds = (b[0][1], b[0][0], b[1][1], b[1][0])

    # prioriza os bounds da ortofoto (mais precisos/maiores em geral); cai pra
    # vegetacao se nao houver ortofoto neste item
    bounds_4326 = ortho_bounds or veg_bounds
    if bounds_4326 is None:
        raise ValueError(f"nao foi possivel determinar bounds para {label}")

    write_flight_meta(out_dir, project_slug, project_name, date, block,
                       bounds_4326, has_ortho, has_vegetation, classes)
    log(f"=== OK: {label} ===")
    return out_dir


def rebuild_catalog():
    log("Reconstruindo catalog.json ...")
    projects = {}  # id -> {"id","name","flights":[...]}

    for meta_path in sorted(glob.glob(os.path.join(DATA_DIR, "*", "*", "meta.json"))):
        flight_folder = os.path.dirname(meta_path)
        folder_name = os.path.basename(flight_folder)
        project_folder = os.path.basename(os.path.dirname(flight_folder))

        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)

        pid = meta.get("project", project_folder)
        pname = meta.get("projectName", pid)
        date = meta.get("date", folder_name)
        block = meta.get("block")
        has_ortho = meta.get("hasOrtho", True)
        has_vegetation = meta.get("hasVegetation", True)

        rel_base = f"{pid}/{folder_name}"
        entry = projects.setdefault(pid, {"id": pid, "name": pname, "flights": []})
        entry["name"] = pname  # ultima vista vence, mas normalmente e sempre igual

        flight = {
            "date": date,
            "block": block,
            "bounds": meta["bounds"],
            "hasOrtho": has_ortho,
            "hasVegetation": has_vegetation,
        }
        if has_ortho:
            flight.update({
                "tiles": f"{rel_base}/tiles",
                "tileExt": meta.get("tileExt", TILE_EXT),
                "minNativeZoom": meta.get("minNativeZoom", MIN_ZOOM),
                "maxNativeZoom": meta.get("maxNativeZoom", MAX_ZOOM),
            })
        if has_vegetation:
            flight.update({
                "vegetation": f"{rel_base}/vegetacao_4326.geojson",
                "classes": meta.get("classes", []),
            })
        entry["flights"].append(flight)

    project_list = []
    for pid in sorted(projects.keys()):
        p = projects[pid]
        p["flights"].sort(key=lambda fl: (fl["date"], fl["block"] or ""), reverse=True)
        project_list.append(p)

    catalog = {"projects": project_list}
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(CATALOG_PATH, "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)

    n_flights = sum(len(p["flights"]) for p in project_list)
    log(f"Catalogo: {len(project_list)} projeto(s), {n_flights} item(ns) -> {CATALOG_PATH}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", help="slug/nome do projeto, ex: se-t3")
    parser.add_argument("--project-name", help="nome de exibicao do projeto (default: --project)")
    parser.add_argument("--date", help="data do voo, AAAA-MM-DD")
    parser.add_argument("--block", help="bloco/subcampo dentro do projeto (opcional), ex: PCS01")
    parser.add_argument("--src-geojson", help="geojson de vegetacao (EPSG:32724); omitir se este item nao tem vegetacao")
    parser.add_argument("--src-tif", help="ortofoto RGBA; omitir se este item nao tem ortofoto")
    parser.add_argument("--skip-vector", action="store_true")
    parser.add_argument("--skip-raster", action="store_true")
    parser.add_argument("--catalog-only", action="store_true",
                         help="so reconstroi data/catalog.json a partir dos meta.json existentes")
    args = parser.parse_args()

    if args.catalog_only:
        rebuild_catalog()
        log("Concluido.")
        return

    if not args.project or not args.date:
        parser.error("--project e --date sao obrigatorios (ou use --catalog-only)")
    if not args.src_geojson and not args.src_tif:
        parser.error("informe --src-geojson e/ou --src-tif")

    process_flight(
        args.project, args.project_name or args.project, args.date, args.block,
        src_geojson=args.src_geojson, src_tif=args.src_tif,
        skip_vector=args.skip_vector, skip_raster=args.skip_raster,
    )
    rebuild_catalog()
    log("Concluido.")


if __name__ == "__main__":
    main()
