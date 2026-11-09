export async function pipeline(...streams) {
    for (let i = 0; i < streams.length - 1; i++) streams[i].pipe(streams[i + 1]);
    const last = streams[streams.length - 1];
    await new Promise((res, rej) => { last.on('finish', res); last.on('end', res); last.on('error', rej); });
}
export async function finished(s) { await new Promise((res, rej) => { s.on('finish', res); s.on('end', res); s.on('error', rej); }); }
export default { pipeline, finished };
