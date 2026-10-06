"""Non-blocking process locks released by the OS when a collector exits.
Unix flock and Windows msvcrt locking use the same single lock-file convention.
"""
import os,pathlib
class FileLock:
    def __init__(self,path):
        self.path=pathlib.Path(path);self.path.parent.mkdir(parents=True,exist_ok=True)
        self.file=open(self.path,'a+b');self.closed=False
        try:
            if os.name=='nt':
                import msvcrt
                if self.file.seek(0,os.SEEK_END)==0:self.file.write(b'\0');self.file.flush()
                self.file.seek(0);msvcrt.locking(self.file.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(self.file,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError as e:
            self.file.close();self.closed=True
            raise BlockingIOError('已有进程持有采集锁') from e
    def close(self):
        if self.closed:return
        try:
            if os.name=='nt':
                import msvcrt
                self.file.seek(0);msvcrt.locking(self.file.fileno(),msvcrt.LK_UNLCK,1)
            else:
                import fcntl
                fcntl.flock(self.file,fcntl.LOCK_UN)
        finally:self.file.close();self.closed=True
