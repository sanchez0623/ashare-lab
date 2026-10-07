"""Content-addressed Parquet tables with logical and physical integrity checks.
The JSON response checkpoints remain the vendor evidence. Parquet is the local
columnar research archive; no forward/back adjustment is applied to raw prices.
"""
import hashlib,json,os,pathlib,tempfile
def encoded(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,allow_nan=False,separators=(',',':')).encode()
def sha(body):return hashlib.sha256(body).hexdigest()
def archive(bundle,root):
    import pyarrow as pa
    import pyarrow.parquet as pq
    root=pathlib.Path(root);root.mkdir(parents=True,exist_ok=True)
    symbol=bundle['metadata']['symbol'];tables={k:bundle[k] for k in ('bars','daily','actions','factors','universe')}
    tables['calendar']=[{'date':d} for d in bundle['calendar']]
    proof={'schemaVersion':1,'symbol':symbol,'source':bundle['metadata']['source'],'priceBasis':'raw','pyarrowVersion':pa.__version__,'tables':{}}
    for name,rows in tables.items():
        fields=sorted({k for r in rows for k in r});expanded=[{key:r.get(key) for key in fields} for r in rows]
        columns={key:[r[key] for r in expanded] for key in fields};table=pa.table(columns);typed=table.to_pylist()
        if typed!=expanded:raise RuntimeError('Parquet类型转换改变原值：'+name)
        digest=sha(encoded(typed));relative=pathlib.Path(symbol)/name/(digest+'.parquet');target=root/relative;receipt=target.with_suffix('.receipt.json')
        if target.exists() or receipt.exists():
            if not target.exists():raise RuntimeError('Parquet文件缺失：'+str(relative))
            if receipt.exists():
                cached=json.loads(receipt.read_bytes())
                if sha(target.read_bytes())!=cached['sha256'] or cached['contentSHA256']!=digest:raise RuntimeError('Parquet归档哈希不一致：'+str(relative))
            # Read back logical rows even after a crash between file/receipt writes.
            if sha(encoded(pq.read_table(target).to_pylist()))!=digest:raise RuntimeError('Parquet归档内容核对失败：'+str(relative))
        else:
            target.parent.mkdir(parents=True,exist_ok=True);fd,temp=tempfile.mkstemp(prefix=digest+'.tmp-',dir=target.parent);os.close(fd)
            try:
                pq.write_table(table,temp,compression='zstd');
                # Windows FlushFileBuffers/_commit requires write access.
                # A read-only descriptor can raise EBADF even though it is
                # valid and the Parquet write itself completed successfully.
                with open(temp,'r+b') as f:f.flush();os.fsync(f.fileno())
                os.replace(temp,target)
            except OSError as e:
                raise RuntimeError('Parquet写入或刷盘失败：'+relative.as_posix()+' · '+str(e)) from e
            finally:
                if os.path.exists(temp):os.unlink(temp)
            if sha(encoded(pq.read_table(target).to_pylist()))!=digest:raise RuntimeError('Parquet写入后内容核对失败：'+str(relative))
        entry={'path':relative.as_posix(),'sha256':sha(target.read_bytes()),'contentSHA256':digest,'rows':len(rows)}
        # Receipt publishing is atomic, and safely regenerated after a crash.
        fd,temp=tempfile.mkstemp(prefix=receipt.name+'.tmp-',dir=receipt.parent)
        try:
            with os.fdopen(fd,'wb') as f:f.write(encoded(entry));f.flush();os.fsync(f.fileno())
            os.replace(temp,receipt)
        finally:
            if os.path.exists(temp):os.unlink(temp)
        proof['tables'][name]=entry
    return proof
