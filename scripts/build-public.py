#!/usr/bin/env python3
"""Export only the standalone public dashboard to a fresh folder. No credentials or database."""
import argparse, pathlib, shutil, subprocess
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output',type=pathlib.Path)
    args=parser.parse_args(); target=args.output.resolve()
    src=pathlib.Path(__file__).resolve().parent.parent; overlay=src/'public-overlay'
    if target.exists() and (not target.is_dir() or any(target.iterdir())):parser.error('Choose a new or empty output directory')
    target.mkdir(parents=True,exist_ok=True)
    for n in ('index.html workspace-ui.js workspace-ui.css dashboard-upgrade.js dashboard-upgrade.css market-client.js market-search.js lightweight-charts-4.1.7.js quant-core.js portfolio-engine.js corporate-actions.js historical-rules.js ledger-adapter.js portfolio-ledger.js holdout.js holdout-ui.js').split():
        shutil.copyfile(src/n,target/n)
    for n in ('portfolio-ui.css responsive-chart.js local-workspace.js mobile-ui.js lab.css').split():shutil.copyfile(overlay/n,target/n)
    for n in ('index.html','workspace-ui.js','dashboard-upgrade.js'):
        subprocess.run(['patch','--batch','--fuzz=0','-i',str(overlay/(n+'.patch')),n],cwd=target,check=True)
    page=target/'index.html'; html=page.read_text()
    canonical='https://dangsijie.com/labs/quant/'
    page.write_text(html.replace('</head>','<link rel="canonical" href="'+canonical+'"><meta property="og:url" content="'+canonical+'"></head>'))
    print('Public dashboard:',target)
if __name__=='__main__':main()
