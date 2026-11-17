// Capture needs a session clock even after rrweb's last event. Keep this patch reproducible when
// rebuilding the vendored player; fail if upstream changes rather than silently losing the bound.
export function patchReplayPlayer(html) {
    const patches = [
        ['start(e){let t=this.firstTimestamp+e;', 'start(e){this.clipStart=e,this.clipClock=performance.now();let t=this.firstTimestamp+e;'],
        ['currentTimestamp(){return this.active.firstTimestamp+', 'currentTimestamp(){if(!this.options.skipInactivity&&this.clipClock!=null)return this.firstTimestamp+this.clipStart+performance.now()-this.clipClock;return this.active.firstTimestamp+'],
        ['onFinish(e){if(this.stopped||e!==this.active)return;', 'onFinish(e){if(this.stopped||e!==this.active)return;if(!this.options.skipInactivity&&this.options.endOffsetS!=null)return;'],
        ['this.stop()}startFrameLoop()', 'if(this.options.endOffsetS==null)this.stop()}startFrameLoop()'],
        ['let t=this.currentTimestamp();this.frameSessionMs.push', 'let t=this.currentTimestamp();if(this.options.endOffsetS!=null&&t>=this.firstTimestamp+this.options.endOffsetS*1e3){this.active.replayer.pause();this.stop();return}this.frameSessionMs.push'],
    ]
    for (const [before, after] of patches) {
        if (html.split(before).length !== 2) throw new Error('Replay player changed; review the clip clock patch')
        html = html.replace(before, after)
    }
    return html
}
