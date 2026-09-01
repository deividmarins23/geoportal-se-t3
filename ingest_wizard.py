# -*- coding: utf-8 -*-
"""
Assistente interativo pra alimentar o GEOPORTAL sem precisar decorar os
parametros do build_data.py.

Roda por RUN_ADICIONAR_DADOS.bat (duplo-clique) ou:
    python ingest_wizard.py

O que ele faz:
  1. Mostra o que ja esta carregado (projetos, blocos/subcampos, datas).
  2. Pergunta quantos itens novos voce quer processar agora.
  3. Pra cada item, pergunta projeto, bloco (opcional), data, e os arquivos de
     origem (geojson de vegetacao e/ou ortofoto -- pode ter so um dos dois).
  4. Processa cada item chamando build_data.process_flight() -- isso SO mexe
     na pasta daquele item especifico. Nada que ja existe e reprocessado.
  5. No fim, reconstroi o catalogo uma unica vez e pergunta se quer publicar
     (git add/commit/push) na hora.

Exemplo de uso pra uma usina solar com 20 subcampos: voce roda esse assistente
hoje apontando so pro PCS01, o catalogo fica com 1 subcampo carregado; semana
que vem, quando o PCS02 for voado, roda de novo apontando so pro PCS02 -- o
PCS01 continua exatamente como estava, ninguem reprocessa ele por engano.
"""
import json
import os
import subprocess
import sys
from datetime import date

import build_data

DATA_DIR = build_data.DATA_DIR
CATALOG_PATH = build_data.CATALOG_PATH


def clean_path(raw):
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in ("'", '"'):
        raw = raw[1:-1]
    return raw


def ask(prompt, default=None, required=False):
    suffix = f" [{default}]" if default else ""
    while True:
        val = input(f"{prompt}{suffix}: ").strip()
        if not val and default is not None:
            return default
        if not val and not required:
            return ""
        if val:
            return val
        print("  -> obrigatorio, tente de novo.")


def ask_path(prompt, required=False):
    while True:
        val = clean_path(input(f"{prompt}: "))
        if not val:
            if required:
                print("  -> obrigatorio, tente de novo.")
                continue
            return ""
        if not os.path.isfile(val):
            print(f"  -> arquivo nao encontrado: {val}")
            retry = input("     tentar de novo? [S/n] ").strip().lower()
            if retry == "n":
                return ""
            continue
        return val


def show_current_catalog():
    if not os.path.exists(CATALOG_PATH):
        print("Nenhum dado carregado ainda.\n")
        return
    with open(CATALOG_PATH, "r", encoding="utf-8") as f:
        catalog = json.load(f)

    projects = catalog.get("projects", [])
    if not projects:
        print("Nenhum dado carregado ainda.\n")
        return

    print("=== Ja carregado no geoportal ===")
    for p in projects:
        print(f"- {p['name']} ({p['id']}): {len(p['flights'])} item(ns)")
        for fl in p["flights"]:
            tag = fl["block"] or "(sem bloco)"
            partes = []
            if fl.get("hasOrtho"):
                partes.append("ortofoto")
            if fl.get("hasVegetation"):
                partes.append("vegetacao")
            print(f"    {fl['date']}  {tag}  [{', '.join(partes) or 'vazio'}]")
    print()


def main():
    print("=" * 60)
    print(" GEOPORTAL - Assistente de ingestao de dados")
    print("=" * 60)
    print()
    show_current_catalog()

    while True:
        n_raw = ask("Quantos itens (projeto/data/bloco) voce quer processar agora", required=True)
        try:
            n = int(n_raw)
            if n > 0:
                break
        except ValueError:
            pass
        print("  -> informe um numero inteiro maior que zero.")

    processed = []
    today = date.today().isoformat()

    for i in range(1, n + 1):
        print(f"\n--- Item {i}/{n} ---")
        project_name = ask("Nome de exibicao do projeto (ex: SE-T3, Usina Solar Boa Vista)", required=True)
        project_slug = build_data.slugify(project_name)
        print(f"  (identificador interno: {project_slug} -- reusa o mesmo se for o mesmo projeto de antes)")

        block = ask("Bloco/subcampo dentro do projeto (Enter se o projeto nao tiver blocos)")
        block = block or None

        flight_date = ask("Data do voo (AAAA-MM-DD)", default=today)

        print("Aponte os arquivos de origem deste item (pode deixar um em branco se nao existir):")
        src_geojson = ask_path("  GeoJSON de vegetacao classificada (Enter se este item nao tem)")
        src_tif = ask_path("  Ortofoto .tif (Enter se este item nao tem)")

        if not src_geojson and not src_tif:
            print("  -> nenhum arquivo apontado, pulando este item.")
            continue

        try:
            out_dir = build_data.process_flight(
                project_slug, project_name, flight_date, block,
                src_geojson=src_geojson or None,
                src_tif=src_tif or None,
            )
            processed.append(out_dir)
        except Exception as e:
            print(f"  -> ERRO processando este item: {e}")
            print("     os itens ja processados antes deste continuam intactos.")

    if not processed:
        print("\nNenhum item novo processado. Nada a atualizar no catalogo.")
        return

    print(f"\n{len(processed)} item(ns) processado(s). Reconstruindo catalogo...")
    build_data.rebuild_catalog()

    publish = input("\nPublicar agora (git add + commit + push)? [S/n] ").strip().lower()
    if publish != "n":
        run_git_publish(len(processed))
    else:
        print("Ok, nao publiquei. Quando quiser: git add . && git commit -m \"...\" && git push")


def run_git_publish(n_itens):
    cwd = build_data.WEBGIS_DIR
    msg = f"Adiciona {n_itens} item(ns) ao geoportal"
    try:
        subprocess.run(["git", "add", "."], cwd=cwd, check=True)
        subprocess.run(["git", "commit", "-m", msg], cwd=cwd, check=True)
        subprocess.run(["git", "push"], cwd=cwd, check=True)
        print("\nPublicado! O GitHub Pages atualiza em ~1 minuto.")
    except FileNotFoundError:
        print("\nGit nao encontrado no PATH -- publique manualmente depois.")
    except subprocess.CalledProcessError as e:
        print(f"\nFalha ao publicar (codigo {e.returncode}). Publique manualmente com git add/commit/push.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nCancelado.")
        sys.exit(1)
    input("\nPressione Enter para fechar...")
