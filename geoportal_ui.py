# -*- coding: utf-8 -*-
"""
GEOPORTAL - Gerenciador de Dados (interface grafica)

Front-end Tkinter para carregar projetos/blocos/voos no geoportal sem usar
linha de comando. Reaproveita a mesma logica de processamento do
build_data.py (process_flight / rebuild_catalog) -- essa tela e so uma forma
mais facil de preencher os parametros e acompanhar o progresso.

Uso:
    python geoportal_ui.py
(ou duplo-clique em GEOPORTAL_GERENCIADOR.bat)
"""
import datetime
import json
import os
import queue
import re
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, scrolledtext

import build_data as bd

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("GEOPORTAL — Gerenciador de Dados")
        self.geometry("920x760")
        self.minsize(760, 600)

        self.log_queue = queue.Queue()
        self.busy = False

        self._build_ui()
        self._refresh_catalog()
        self.after(150, self._poll_log_queue)

    # ------------------------------------------------------------------
    # UI
    # ------------------------------------------------------------------
    def _build_ui(self):
        style = ttk.Style(self)
        try:
            style.theme_use("vista")
        except tk.TclError:
            pass
        style.configure("Primary.TButton", font=("Segoe UI", 10, "bold"))
        style.configure("Header.TLabel", font=("Segoe UI", 13, "bold"), foreground="#0a355c")
        style.configure("Sub.TLabel", foreground="#666666")

        root = ttk.Frame(self, padding=12)
        root.pack(fill="both", expand=True)
        root.columnconfigure(0, weight=1)

        # --- Cabecalho ---------------------------------------------------
        ttk.Label(root, text="GEOPORTAL — Gerenciador de Dados", style="Header.TLabel").grid(
            row=0, column=0, sticky="w")
        ttk.Label(root, text="Carregue ortofotos e vegetação classificada por projeto, sem usar linha de comando.",
                   style="Sub.TLabel").grid(row=1, column=0, sticky="w", pady=(0, 10))

        # --- O que ja esta carregado --------------------------------------
        cat_frame = ttk.LabelFrame(root, text="Já carregado no geoportal", padding=8)
        cat_frame.grid(row=2, column=0, sticky="nsew", pady=(0, 10))
        root.rowconfigure(2, weight=1)
        cat_frame.columnconfigure(0, weight=1)
        cat_frame.rowconfigure(0, weight=1)

        cols = ("projeto", "bloco", "data", "ortofoto", "vegetacao")
        self.tree = ttk.Treeview(cat_frame, columns=cols, show="headings", height=8)
        for c, w, t in [("projeto", 160, "Projeto"), ("bloco", 110, "Bloco"), ("data", 90, "Data"),
                         ("ortofoto", 80, "Ortofoto"), ("vegetacao", 90, "Vegetação")]:
            self.tree.heading(c, text=t)
            self.tree.column(c, width=w, anchor="w")
        self.tree.grid(row=0, column=0, sticky="nsew")
        sb = ttk.Scrollbar(cat_frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=sb.set)
        sb.grid(row=0, column=1, sticky="ns")

        btn_row = ttk.Frame(cat_frame)
        btn_row.grid(row=1, column=0, columnspan=2, sticky="w", pady=(6, 0))
        ttk.Button(btn_row, text="Atualizar lista", command=self._refresh_catalog).pack(side="left")
        ttk.Button(btn_row, text="Abrir geoportal local", command=self._open_local_geoportal).pack(
            side="left", padx=(8, 0))

        # --- Formulario de novo item --------------------------------------
        form = ttk.LabelFrame(root, text="Adicionar novo item (projeto + data + bloco opcional)", padding=10)
        form.grid(row=3, column=0, sticky="ew", pady=(0, 10))
        form.columnconfigure(1, weight=1)

        r = 0
        ttk.Label(form, text="Projeto:").grid(row=r, column=0, sticky="w", pady=3)
        self.project_var = tk.StringVar()
        self.project_combo = ttk.Combobox(form, textvariable=self.project_var, values=[])
        self.project_combo.grid(row=r, column=1, sticky="ew", pady=3)
        self.project_combo.bind("<KeyRelease>", self._update_slug_hint)
        self.project_combo.bind("<<ComboboxSelected>>", self._update_slug_hint)
        self.slug_hint = ttk.Label(form, text="", style="Sub.TLabel")
        self.slug_hint.grid(row=r, column=2, sticky="w", padx=(8, 0))
        r += 1

        ttk.Label(form, text="Bloco/subcampo (opcional):").grid(row=r, column=0, sticky="w", pady=3)
        self.block_var = tk.StringVar()
        ttk.Entry(form, textvariable=self.block_var).grid(row=r, column=1, sticky="ew", pady=3)
        ttk.Label(form, text="deixe em branco se o projeto não tiver subcampos", style="Sub.TLabel").grid(
            row=r, column=2, sticky="w", padx=(8, 0))
        r += 1

        ttk.Label(form, text="Data do voo:").grid(row=r, column=0, sticky="w", pady=3)
        self.date_var = tk.StringVar(value=datetime.date.today().isoformat())
        ttk.Entry(form, textvariable=self.date_var, width=16).grid(row=r, column=1, sticky="w", pady=3)
        ttk.Label(form, text="formato AAAA-MM-DD", style="Sub.TLabel").grid(
            row=r, column=2, sticky="w", padx=(8, 0))
        r += 1

        ttk.Label(form, text="Vegetação (GeoJSON):").grid(row=r, column=0, sticky="w", pady=3)
        self.veg_path_var = tk.StringVar()
        veg_row = ttk.Frame(form)
        veg_row.grid(row=r, column=1, columnspan=2, sticky="ew", pady=3)
        veg_row.columnconfigure(0, weight=1)
        ttk.Entry(veg_row, textvariable=self.veg_path_var, state="readonly").grid(row=0, column=0, sticky="ew")
        ttk.Button(veg_row, text="Procurar...", command=self._pick_geojson).grid(row=0, column=1, padx=(6, 0))
        ttk.Button(veg_row, text="Limpar", command=lambda: self.veg_path_var.set("")).grid(row=0, column=2, padx=(6, 0))
        r += 1

        ttk.Label(form, text="Ortofoto (.tif):").grid(row=r, column=0, sticky="w", pady=3)
        self.tif_path_var = tk.StringVar()
        tif_row = ttk.Frame(form)
        tif_row.grid(row=r, column=1, columnspan=2, sticky="ew", pady=3)
        tif_row.columnconfigure(0, weight=1)
        ttk.Entry(tif_row, textvariable=self.tif_path_var, state="readonly").grid(row=0, column=0, sticky="ew")
        ttk.Button(tif_row, text="Procurar...", command=self._pick_tif).grid(row=0, column=1, padx=(6, 0))
        ttk.Button(tif_row, text="Limpar", command=lambda: self.tif_path_var.set("")).grid(row=0, column=2, padx=(6, 0))
        r += 1

        ttk.Label(form, text="Nome de exibição (opcional):").grid(row=r, column=0, sticky="w", pady=3)
        self.project_name_var = tk.StringVar()
        ttk.Entry(form, textvariable=self.project_name_var).grid(row=r, column=1, sticky="ew", pady=3)
        ttk.Label(form, text="se vazio, usa o mesmo texto do campo Projeto", style="Sub.TLabel").grid(
            row=r, column=2, sticky="w", padx=(8, 0))
        r += 1

        self.autopublish_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(form, text="Publicar automaticamente (git push) após processar",
                         variable=self.autopublish_var).grid(row=r, column=0, columnspan=2, sticky="w", pady=(6, 0))
        r += 1

        action_row = ttk.Frame(form)
        action_row.grid(row=r, column=0, columnspan=3, sticky="ew", pady=(10, 0))
        self.process_btn = ttk.Button(action_row, text="Processar este item", style="Primary.TButton",
                                       command=self._on_process_clicked)
        self.process_btn.pack(side="left")
        self.publish_btn = ttk.Button(action_row, text="Publicar agora (git push)", command=self._on_publish_clicked)
        self.publish_btn.pack(side="left", padx=(8, 0))

        self.progress = ttk.Progressbar(root, mode="indeterminate")
        self.status_label = ttk.Label(root, text="", style="Sub.TLabel")
        self.status_label.grid(row=4, column=0, sticky="w")

        # --- Log ------------------------------------------------------------
        log_frame = ttk.LabelFrame(root, text="Andamento", padding=6)
        log_frame.grid(row=5, column=0, sticky="nsew")
        root.rowconfigure(5, weight=1)
        log_frame.columnconfigure(0, weight=1)
        log_frame.rowconfigure(0, weight=1)
        self.log_text = scrolledtext.ScrolledText(log_frame, height=10, font=("Consolas", 9), state="disabled")
        self.log_text.grid(row=0, column=0, sticky="nsew")

    # ------------------------------------------------------------------
    # Catalogo
    # ------------------------------------------------------------------
    def _load_catalog(self):
        if not os.path.exists(bd.CATALOG_PATH):
            return {"projects": []}
        with open(bd.CATALOG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)

    def _refresh_catalog(self):
        catalog = self._load_catalog()
        self.tree.delete(*self.tree.get_children())
        names = []
        for p in catalog.get("projects", []):
            names.append(p["name"])
            for fl in p.get("flights", []):
                self.tree.insert("", "end", values=(
                    p["name"], fl.get("block") or "—", fl.get("date", ""),
                    "sim" if fl.get("hasOrtho") else "não",
                    "sim" if fl.get("hasVegetation") else "não",
                ))
        self.project_combo["values"] = names
        self._catalog_cache = catalog

    def _update_slug_hint(self, _event=None):
        name = self.project_var.get().strip()
        if not name:
            self.slug_hint.configure(text="")
            return
        self.slug_hint.configure(text="id interno: " + bd.slugify(name))

    def _project_blocks_mode(self, project_name):
        """True se o projeto ja existente usa blocos, False se usa datas simples, None se e novo."""
        slug = bd.slugify(project_name)
        for p in self._catalog_cache.get("projects", []):
            if p["id"] == slug:
                return any(fl.get("block") for fl in p.get("flights", []))
        return None

    # ------------------------------------------------------------------
    # Selecao de arquivos
    # ------------------------------------------------------------------
    def _pick_geojson(self):
        path = filedialog.askopenfilename(
            title="Selecione o GeoJSON de vegetação classificada",
            filetypes=[("GeoJSON", "*.geojson"), ("Todos os arquivos", "*.*")])
        if path:
            self.veg_path_var.set(path)

    def _pick_tif(self):
        path = filedialog.askopenfilename(
            title="Selecione a ortofoto",
            filetypes=[("GeoTIFF", "*.tif;*.tiff"), ("Todos os arquivos", "*.*")])
        if path:
            self.tif_path_var.set(path)

    # ------------------------------------------------------------------
    # Processamento
    # ------------------------------------------------------------------
    def _on_process_clicked(self):
        if self.busy:
            return

        project_name = self.project_var.get().strip()
        block = self.block_var.get().strip() or None
        date_str = self.date_var.get().strip()
        veg = self.veg_path_var.get().strip() or None
        tif = self.tif_path_var.get().strip() or None
        display_name = self.project_name_var.get().strip() or project_name

        if not project_name:
            messagebox.showwarning("Campo obrigatório", "Informe o nome do projeto.")
            return
        if not DATE_RE.match(date_str):
            messagebox.showwarning("Data inválida", "A data deve estar no formato AAAA-MM-DD, ex: 2026-09-15.")
            return
        if not veg and not tif:
            messagebox.showwarning(
                "Nenhum arquivo selecionado",
                "Selecione pelo menos um arquivo: a vegetação classificada e/ou a ortofoto deste item.")
            return

        existing_mode = self._project_blocks_mode(project_name)
        if existing_mode is not None:
            new_has_block = block is not None
            if existing_mode != new_has_block:
                msg = (
                    "O projeto \"{}\" já tem itens {} bloco, e este item novo está {} bloco.\n\n"
                    "Itens sem bloco ficam invisíveis no site quando o projeto também tem itens "
                    "com bloco. Recomendo manter o padrão (todos com bloco, ou todos sem).\n\n"
                    "Continuar mesmo assim?"
                ).format(
                    project_name,
                    "com" if existing_mode else "sem",
                    "com" if new_has_block else "sem",
                )
                if not messagebox.askyesno("Aviso de consistência", msg):
                    return

        self._set_busy(True, "Processando \"{}\"...".format(project_name))

        def worker():
            original_log = bd.log
            bd.log = lambda msg: self.log_queue.put("[build_data] " + msg)
            try:
                bd.process_flight(
                    project_name, display_name, date_str, block,
                    src_geojson=veg, src_tif=tif,
                )
                bd.rebuild_catalog()
                self.log_queue.put("__DONE_OK__")
            except Exception as e:
                self.log_queue.put("ERRO: " + str(e))
                self.log_queue.put("__DONE_ERR__")
            finally:
                bd.log = original_log

        threading.Thread(target=worker, daemon=True).start()

    def _on_process_finished(self, ok):
        self._set_busy(False, "")
        self._refresh_catalog()
        if ok:
            messagebox.showinfo("Concluído", "Item processado com sucesso.")
            self.veg_path_var.set("")
            self.tif_path_var.set("")
            self.block_var.set("")
            if self.autopublish_var.get():
                self._on_publish_clicked()
        else:
            messagebox.showerror("Falha ao processar",
                                  "Não foi possível processar este item. Veja o log de andamento pra detalhes.")

    # ------------------------------------------------------------------
    # Publicacao (git)
    # ------------------------------------------------------------------
    def _on_publish_clicked(self):
        if self.busy:
            return
        self._set_busy(True, "Publicando no GitHub Pages...")

        def worker():
            try:
                cwd = bd.WEBGIS_DIR
                msg = "Atualiza dados do geoportal ({})".format(datetime.date.today().isoformat())
                for cmd in (["git", "add", "."], ["git", "commit", "-m", msg], ["git", "push"]):
                    self.log_queue.put("$ " + " ".join(cmd))
                    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
                    if r.stdout.strip():
                        self.log_queue.put(r.stdout.strip())
                    if r.stderr.strip():
                        self.log_queue.put(r.stderr.strip())
                    if r.returncode != 0 and cmd[1] != "commit":
                        # "nada para commitar" nao e erro real, so nao ha mudancas
                        raise RuntimeError("comando falhou: " + " ".join(cmd))
                self.log_queue.put("__PUBLISH_OK__")
            except Exception as e:
                self.log_queue.put("ERRO ao publicar: " + str(e))
                self.log_queue.put("__PUBLISH_ERR__")

        threading.Thread(target=worker, daemon=True).start()

    def _on_publish_finished(self, ok):
        self._set_busy(False, "")
        if ok:
            messagebox.showinfo("Publicado", "Alterações enviadas! O site atualiza em ~1 minuto.")
        else:
            messagebox.showerror(
                "Falha ao publicar",
                "Não foi possível publicar automaticamente. Veja o log — pode ser preciso publicar "
                "manualmente pelo terminal (git add / commit / push).")

    # ------------------------------------------------------------------
    # Utilitarios de UI
    # ------------------------------------------------------------------
    def _set_busy(self, busy, status_text):
        self.busy = busy
        state = "disabled" if busy else "normal"
        self.process_btn.configure(state=state)
        self.publish_btn.configure(state=state)
        self.status_label.configure(text=status_text)
        if busy:
            self.progress.grid(row=4, column=0, sticky="ew", pady=(2, 4))
            self.progress.start(12)
        else:
            self.progress.stop()
            self.progress.grid_forget()

    def _append_log(self, text):
        self.log_text.configure(state="normal")
        self.log_text.insert("end", text + "\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _poll_log_queue(self):
        try:
            while True:
                line = self.log_queue.get_nowait()
                if line == "__DONE_OK__":
                    self._on_process_finished(True)
                elif line == "__DONE_ERR__":
                    self._on_process_finished(False)
                elif line == "__PUBLISH_OK__":
                    self._on_publish_finished(True)
                elif line == "__PUBLISH_ERR__":
                    self._on_publish_finished(False)
                else:
                    self._append_log(line)
        except queue.Empty:
            pass
        self.after(150, self._poll_log_queue)

    def _open_local_geoportal(self):
        try:
            subprocess.Popen([sys.executable, os.path.join(bd.WEBGIS_DIR, "server.py")], cwd=bd.WEBGIS_DIR)
        except Exception as e:
            messagebox.showerror("Erro", "Não foi possível abrir o servidor local: " + str(e))


if __name__ == "__main__":
    app = App()
    app.mainloop()
