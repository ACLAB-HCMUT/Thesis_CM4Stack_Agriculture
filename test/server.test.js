const serverModule = require('../server'); // Import the server module
const request = require('supertest');
const sinon = require('sinon');
const jwt = require('jsonwebtoken');
const { expect } = require('chai');
const { app, addMqttUser, addMqttAcl, reloadMosquitto } = serverModule; // Destructure exports
const db = require('../db'); // Adjust path to your db module

describe('IoT Server API', () => {
    let dbGetStub, dbRunStub, mqttUserStub, mqttAclStub, reloadStub;

    // Setup before each test
    beforeEach(() => {
        // Stub database methods
        dbGetStub = sinon.stub(db, 'get');
        dbRunStub = sinon.stub(db, 'run');

        // Stub Mosquitto functions from the server module
        // mqttUserStub = sinon.stub(serverModule, 'addMqttUser').callsArgWith(2, null); // Stub the actual function
        // mqttUserStub = sinon.stub(serverModule, 'addMqttUser').callsFake((username, password, callback) => {
        //   console.log('Stubbed addMqttUser called with:', username, password);
        //   callback(null);
        // });
        // mqttAclStub = sinon.stub(serverModule, 'addMqttAcl');
        // reloadStub = sinon.stub(serverModule, 'reloadMosquitto');
    });

    // Cleanup after each test
    afterEach(() => {
        sinon.restore();
    });

    // Tests for /api/validate
    describe('POST /api/validate', () => {
        it('should return 200 and a token if device is registered', async () => {
            dbGetStub.withArgs(
                'SELECT username, password FROM devices WHERE mac_address = ?',
                ['00:11:22:33:44:55']
            ).callsArgWith(2, null, { username: 'user_001122334455', password: 'testpass' });

            const res = await request(app)
                .post('/api/validate')
                .send({ mac_address: '00:11:22:33:44:55' });

            expect(res.status).to.equal(200);
            expect(res.body).to.have.property('token');
            expect(res.body.message).to.equal('Device validated.');
        });

        it('should return 404 if device is not registered', async () => {
            dbGetStub.withArgs(
                'SELECT username, password FROM devices WHERE mac_address = ?',
                ['00:11:22:33:44:55']
            ).callsArgWith(2, null, null);

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

    // Tests for /api/register
    describe('POST /api/register', () => {
        it('should register a new device and return 201 with MQTT credentials', async () => {
            dbRunStub.withArgs(
                'INSERT INTO devices (mac_address, username, password) VALUES (?, ?, ?)',
                sinon.match.array
            ).callsArgWith(2, null);

            const res = await request(app)
                .post('/api/register')
                .send({ mac_address: '00:11:22:33:44:55' });

            expect(res.status).to.equal(201);
            expect(res.body).to.have.property('mqtt_username');
            expect(res.body).to.have.property('mqtt_password');
            expect(res.body.message).to.equal('Device registered successfully.');
        });

        it('should return 409 if device is already registered', async () => {
            dbRunStub.withArgs(
                'INSERT INTO devices (mac_address, username, password) VALUES (?, ?, ?)',
                sinon.match.array
            ).callsArgWith(2, { code: 'SQLITE_CONSTRAINT' });

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

    // Tests for /api/get-mqtt-info
    describe('GET /api/get-mqtt-info', () => {
        it('should return 200 and MQTT info if token and username are valid', async () => {
            const token = jwt.sign({ mac_address: '00:11:22:33:44:55' }, process.env.JWT_SECRET_KEY || 'your_jwt_secret');
            dbGetStub.withArgs(
                'SELECT * FROM devices WHERE username = ?',
                ['user_001122334455']
            ).callsArgWith(2, null, { username: 'user_001122334455' });

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

        it('should return 404 if username is not found', async () => {
            const token = jwt.sign({ mac_address: '00:11:22:33:44:55' }, process.env.JWT_SECRET_KEY || 'your_jwt_secret');
            dbGetStub.withArgs(
                'SELECT * FROM devices WHERE username = ?',
                ['unknown']
            ).callsArgWith(2, null, null);

            const res = await request(app)
                .get('/api/get-mqtt-info')
                .set('Authorization', `Bearer ${token}`)
                .query({ username: 'unknown' });

            expect(res.status).to.equal(404);
            expect(res.body.message).to.equal('Device not registered.');
        });
    });
});