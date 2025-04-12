const serverModule = require('../server');
const request = require('supertest');
const sinon = require('sinon');
const jwt = require('jsonwebtoken');
const { expect } = require('chai');
const { app } = serverModule;
const db = require('../db');

describe('IoT Server API', () => {
    let dbGetStub, dbRunStub;

    beforeEach(() => {
        dbGetStub = sinon.stub(db, 'get');
        dbRunStub = sinon.stub(db, 'run');
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('POST /api/validate', () => {
        it('should return 200 and tokens if device is registered', async () => {
            dbGetStub
                .withArgs(
                    'SELECT username, password FROM devices WHERE mac_address = ?',
                    ['00:11:22:33:44:55']
                )
                .callsArgWith(2, null, { username: 'user_001122334455', password: 'testpass' });

            dbRunStub
                .withArgs(
                    'UPDATE devices SET refresh_token = ? WHERE mac_address = ?',
                    sinon.match.array
                )
                .callsArgWith(2, null);

            const res = await request(app)
                .post('/api/validate')
                .send({ mac_address: '00:11:22:33:44:55' });

            expect(res.status).to.equal(200);
            expect(res.body).to.have.property('accessToken');
            expect(res.body).to.have.property('refreshToken');
            expect(res.body.message).to.equal('Device validated.');
        });

        it('should return 404 if device is not registered', async () => {
            dbGetStub
                .withArgs(
                    'SELECT username, password FROM devices WHERE mac_address = ?',
                    ['00:11:22:33:44:55']
                )
                .callsArgWith(2, null, null);

            const res = await request(app)
                .post('/api/validate')
                .send({ mac_address: '00:11:22:33:44:55' });

            expect(res.status).to.equal(404);
            expect(res.body.message).to.equal('Device not registered.');
        });

        it('should return 400 if MAC address is missing', async () => {
            const res = await request(app)
                .post('/api/validate')
                .send({});

            expect(res.status).to.equal(400);
            expect(res.body.message).to.equal('MAC address is required.');
        });
    });

    describe('POST /api/register', () => {
        it('should register a new device and return 201 with MQTT credentials', async () => {
            dbRunStub
                .withArgs(
                    'INSERT INTO devices (mac_address, username, password) VALUES (?, ?, ?)',
                    sinon.match.array
                )
                .callsArgWith(2, null);

            const res = await request(app)
                .post('/api/register')
                .send({ mac_address: '00:11:22:33:44:55' });

            expect(res.status).to.equal(201);
            expect(res.body).to.have.property('mqtt_username');
            expect(res.body).to.have.property('mqtt_password');
            expect(res.body.message).to.equal('Device registered successfully.');
        });

        it('should return 409 if device is already registered', async () => {
            dbRunStub
                .withArgs(
                    'INSERT INTO devices (mac_address, username, password) VALUES (?, ?, ?)',
                    sinon.match.array
                )
                .callsArgWith(2, { code: 'SQLITE_CONSTRAINT' });

            const res = await request(app)
                .post('/api/register')
                .send({ mac_address: '00:11:22:33:44:55' });

            expect(res.status).to.equal(409);
            expect(res.body.message).to.equal('Device already registered.');
        });

        it('should return 400 if MAC address is missing', async () => {
            const res = await request(app)
                .post('/api/register')
                .send({});

            expect(res.status).to.equal(400);
            expect(res.body.message).to.equal('MAC address is required.');
        });
    });

    describe('GET /api/get-mqtt-info', () => {
        it('should return 200 and MQTT info if token and username are valid', async () => {
            const token = jwt.sign(
                { mac_address: '00:11:22:33:44:55' },
                process.env.JWT_SECRET_KEY || 'your_jwt_secret'
            );
            dbGetStub
                .withArgs(
                    'SELECT * FROM devices WHERE username = ?',
                    ['user_001122334455']
                )
                .callsArgWith(2, null, { username: 'user_001122334455' });

            const res = await request(app)
                .get('/api/get-mqtt-info')
                .set('Authorization', `Bearer ${token}`)
                .query({ username: 'user_001122334455' });

            expect(res.status).to.equal(200);
            expect(res.body).to.have.property('mqttInfo');
            expect(res.body.mqttInfo).to.have.property('broker_ip', '172.28.182.164');
            expect(res.body.mqttInfo).to.have.property('port', 1883);
            expect(res.body.message).to.equal('MQTT information retrieved successfully.');
        });

        it('should return 403 if token is missing', async () => {
            const res = await request(app)
                .get('/api/get-mqtt-info')
                .query({ username: 'user_001122334455' });

            expect(res.status).to.equal(403);
            expect(res.body.message).to.equal('Token is required.');
        });

        it('should return 403 if access token is invalid', async () => {
            const invalidToken = "invalid_token_string";
            const res = await request(app)
                .get('/api/get-mqtt-info')
                .set('Authorization', `Bearer ${invalidToken}`)
                .query({ username: 'user_001122334455' });
            expect(res.status).to.equal(403);
            expect(res.body.message).to.equal('Invalid or expired token.');
        });
        
        it('should return 403 if access token is expired', async () => {
            const expiredToken = jwt.sign(
                {mac_address: '00:11:22:33:44:55'},
                process.env.JWT_SECRET_KEY || 'your_jwt_secret',
                { expiresIn: '1ms' }
            );
            await new Promise((resolve) => setTimeout(resolve, 10));
            const res = await request(app)
                .get('/api/get-mqtt-info')
                .set('Authorization', `Bearer ${expiredToken}`)
                .query({ username: 'user_001122334455' });
            expect(res.status).to.equal(403);
            expect(res.body.message).to.equal('Invalid or expired token.');
        });

        it('should return 404 if username is not found', async () => {
            const token = jwt.sign(
                { mac_address: '00:11:22:33:44:55' },
                process.env.JWT_SECRET_KEY || 'your_jwt_secret'
            );
            dbGetStub
                .withArgs(
                    'SELECT * FROM devices WHERE username = ?',
                    ['unknown']
                )
                .callsArgWith(2, null, null);

            const res = await request(app)
                .get('/api/get-mqtt-info')
                .set('Authorization', `Bearer ${token}`)
                .query({ username: 'unknown' });

            expect(res.status).to.equal(404);
            expect(res.body.message).to.equal('Device not registered.');
        });
    });

    describe('POST /api/refresh-token', () => {
        it('should return 200 and a new access token if refresh token is valid', async () => {
            const mac_address = '00:11:22:33:44:55';
            const refreshToken = jwt.sign(
                { mac_address },
                process.env.REFRESH_TOKEN_SECRET || 'your_refresh_secret',
                { expiresIn: '7d' }
            );
            dbGetStub
                .withArgs(
                    'SELECT refresh_token FROM devices WHERE mac_address = ?',
                    [mac_address]
                )
                .callsArgWith(2, null, { refresh_token: refreshToken });

            const res = await request(app)
                .post('/api/refresh-token')
                .send({ refreshToken });

            expect(res.status).to.equal(200);
            expect(res.body).to.have.property('accessToken');
            expect(res.body.message).to.equal('Access token refreshed.');
        });

        it('should return 403 if refresh token is invalid', async () => {
            const invalidToken = 'invalid_token_string';
            const res = await request(app)
                .post('/api/refresh-token')
                .send({ refreshToken: invalidToken });

            expect(res.status).to.equal(403);
            expect(res.body.message).to.equal('Invalid or expired refresh token.');
        });

        it('should return 403 if refresh token is expired', async () => {
            const mac_address = '00:11:22:33:44:55';
            const expiredToken = jwt.sign(
                { mac_address },
                process.env.REFRESH_TOKEN_SECRET || 'your_refresh_secret',
                { expiresIn: '1ms' }
            );
            await new Promise((resolve) => setTimeout(resolve, 10));
            const res = await request(app)
                .post('/api/refresh-token')
                .send({ refreshToken: expiredToken });

            expect(res.status).to.equal(403);
            expect(res.body.message).to.equal('Invalid or expired refresh token.');
        });

        it('should return 403 if refresh token does not match database', async () => {
            const mac_address = '00:11:22:33:44:55';
            const refreshToken = jwt.sign(
                { mac_address },
                process.env.REFRESH_TOKEN_SECRET || 'your_refresh_secret',
                { expiresIn: '7d' }
            );
            dbGetStub
                .withArgs(
                    'SELECT refresh_token FROM devices WHERE mac_address = ?',
                    [mac_address]
                )
                .callsArgWith(2, null, { refresh_token: 'different_token' });

            const res = await request(app)
                .post('/api/refresh-token')
                .send({ refreshToken });

            expect(res.status).to.equal(403);
            expect(res.body.message).to.equal('Invalid refresh token.');
        });

        it('should return 400 if refresh token is missing', async () => {
            const res = await request(app)
                .post('/api/refresh-token')
                .send({});

            expect(res.status).to.equal(400);
            expect(res.body.message).to.equal('Refresh token is required.');
        });
    });
});