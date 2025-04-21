#!/bin/bash
mkdir -p certificates
openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout certificates/private.key -out certificates/certificate.pem -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost"