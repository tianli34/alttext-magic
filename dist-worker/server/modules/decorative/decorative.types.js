export class DecorativeActionError extends Error {
    code;
    status;
    constructor(code, message, status) {
        super(message);
        this.name = "DecorativeActionError";
        this.code = code;
        this.status = status;
    }
}
