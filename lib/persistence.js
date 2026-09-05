const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function syncDirectory(directory) {
    if (process.platform === 'win32') return;
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeAtomic(file, contents) {
    const temporary = file + '.' + randomUUID() + '.tmp';
    let fd;
    try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, contents, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temporary, file);
        syncDirectory(path.dirname(file));
    } catch (error) {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (cleanupError) {
            if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError;
        }
        error.statusCode = 500;
        throw error;
    }
}

function removeFile(file) {
    try { fs.unlinkSync(file); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    syncDirectory(path.dirname(file));
}

module.exports = { writeAtomic, removeFile };
