import hashlib
import json
from time import time
from uuid import uuid4
from flask import Flask, request, jsonify
import requests

class Blockchain:

    def __init__(self):
        self.chain = []
        self.transactions = []
        self.nodes = set()

        self.create_block(previous_hash='0')

    def create_block(self, previous_hash):
        block = {
            'index': len(self.chain) + 1,
            'timestamp': time(),
            'transactions': self.transactions,
            'previous_hash': previous_hash
        }

        block_string = json.dumps(block, sort_keys=True).encode()
        block['hash'] = hashlib.sha256(block_string).hexdigest()

        self.transactions = []
        self.chain.append(block)
        return block

    def add_transaction(self, sender, receiver, amount):
        self.transactions.append({
            'sender': sender,
            'receiver': receiver,
            'amount': amount
        })

    def register_node(self, address):
        self.nodes.add(address)

    def get_last_block(self):
        return self.chain[-1]


# Flask server
app = Flask(__name__)
node_id = str(uuid4()).replace('-', '')

blockchain = Blockchain()


@app.route('/mine', methods=['GET'])
def mine():
    last_block = blockchain.get_last_block()
    block = blockchain.create_block(last_block['hash'])

    for node in blockchain.nodes:
        requests.post(f"http://{node}/receive_block", json=block)

    return jsonify(block)


@app.route('/transaction', methods=['POST'])
def transaction():
    values = request.get_json()

    blockchain.add_transaction(
        values['sender'],
        values['receiver'],
        values['amount']
    )

    return jsonify({"message": "Transaction added"})


@app.route('/receive_block', methods=['POST'])
def receive_block():
    block = request.get_json()
    blockchain.chain.append(block)
    return jsonify({"message": "Block received"})


@app.route('/connect', methods=['POST'])
def connect():
    nodes = request.get_json()['nodes']
    for node in nodes:
        blockchain.register_node(node)

    return jsonify({"message": "Nodes connected"})


@app.route('/chain', methods=['GET'])
def chain():
    return jsonify(blockchain.chain)


if __name__ == '__main__':
    app.run(port=5000)