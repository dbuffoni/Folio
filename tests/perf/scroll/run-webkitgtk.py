#!/usr/bin/python3.12
"""Runs the scroll scenarios in WebKitGTK, the engine Tauri uses on Linux.
Usage: xvfb-run -a python3.12 run-webkitgtk.py <base-url> <pdf-url> <out.json>
Needs: libwebkit2gtk-4.1-0 gir1.2-webkit2-4.1 python3-gi gir1.2-gtk-3.0 (python3.12 matches the gi bindings on Ubuntu 24.04)."""
import json, sys
import gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib

base = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4173'
pdf = sys.argv[2] if len(sys.argv) > 2 else '/perf-300.pdf'
out = sys.argv[3] if len(sys.argv) > 3 else 'webkitgtk.json'

win = Gtk.OffscreenWindow(); win.set_default_size(1360, 860)
view = WebKit2.WebView(); win.add(view); win.show_all()

def js(code, cb):
    view.evaluate_javascript(code, -1, None, None, None, lambda v, r: cb(v.evaluate_javascript_finish(r).to_string()))

reports = []
queue = []
def poll(expr, then, tries=600):
    def check(res):
        if res not in ('null', 'undefined', 'false', ''):
            then(res)
        elif tries <= 0:
            print('timeout waiting for', expr); Gtk.main_quit()
        else:
            GLib.timeout_add(200, lambda: (poll(expr, then, tries - 1), False)[1])
    js(expr, check)

def next_scenario(_=None):
    if not queue:
        json.dump(reports, open(out, 'w'), indent=2); print('wrote', out); Gtk.main_quit(); return
    name = queue.pop(0)
    # A fresh page load per run: the render cache would make repeated runs of the same pages free.
    fresh_load(lambda: js(f"window.__res=null; window.__folioPerf.run('{name}').then(r=>window.__res=JSON.stringify(r)).catch(e=>window.__res=JSON.stringify({{error:String(e)}})); 1", lambda _: poll('window.__res', done)))

pending = []
def fresh_load(then):
    pending.append(then); view.load_uri(f'{base}/?perf')

def done(res):
    reports.append(json.loads(res)); next_scenario()

def opened():
    js("window.__n = null; window.__folioPerf.scenarios.join(',')", lambda names: (queue.extend(n for n in names.split(',') for _ in range(3)), next_scenario()))

def open_doc(then):
    js(f"window.__o=null; window.__folioPerf.open('{pdf}').then(()=>window.__o='ok').catch(e=>window.__o='err '+e); 1",
       lambda _: poll("window.__o", lambda r: poll("document.querySelector('.pv canvas') ? 'yes' : null", then) if r == 'ok' else (print(r), Gtk.main_quit())))

def loaded(_):
    open_doc(lambda _: pending.pop()() if pending else opened())

def on_load(v, ev):
    if ev == WebKit2.LoadEvent.FINISHED:
        poll('window.__folioPerf ? "yes" : null', loaded)
view.connect('load-changed', on_load)
view.load_uri(f'{base}/?perf')
GLib.timeout_add(600_000, lambda: (print('global timeout'), Gtk.main_quit()))
Gtk.main()
