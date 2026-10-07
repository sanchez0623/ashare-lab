"""Write verified replacements to new content-addressed Parquet, not the originals."""
import argparse,json,pathlib
from parquet_store import archive
from query_cache import atomic

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--input',required=True);p.add_argument('--output',required=True);p.add_argument('--root',required=True);a=p.parse_args()
    bundle=json.loads(pathlib.Path(a.input).read_bytes());bundle['metadata']['parquetArchive']=archive(bundle,a.root);atomic(a.output,bundle)
if __name__=='__main__':main()
