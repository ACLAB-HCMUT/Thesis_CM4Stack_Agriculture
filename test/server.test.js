const supertest = require('supertest');
const app = require('../server'); // Path to server.js relative to test/

describe('Server', () => {
    it('should return 200 on GET /', (done) => {
        supertest(app)
            .get('/')
            .expect(200)
            .end(done);
    });
});