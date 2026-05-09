export function ok(value) {
    return { ok: true, value };
}
export function err(error) {
    return { ok: false, error };
}
export function isErr(result) {
    return result.ok === false;
}
//# sourceMappingURL=block-state.js.map