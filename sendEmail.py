import smtplib
import ssl
import os
import certifi
from email.message import EmailMessage
import argparse
import sys

def send_email(sender_email, receiver_email, subject, body, attachments):
    msg = EmailMessage()
    msg['From'] = sender_email
    msg['To'] = receiver_email
    msg['Subject'] = subject
    msg.set_content(body)

    # Attach files
    for file_path in attachments:
        try:
            with open(file_path, 'rb') as f:
                file_data = f.read()
                file_name = os.path.basename(file_path)
            msg.add_attachment(
                file_data,
                maintype='application',
                subtype='octet-stream',
                filename=file_name
            )
        except Exception as e:
            print(f"Failed to attach {file_path}: {e}")
            raise

    # Use Gmail SMTP with SSL
    context = ssl.create_default_context(cafile=certifi.where())
    with smtplib.SMTP_SSL('smtp.gmail.com', 465, context=context) as server:
        server.login(sender_email, 'mrfqywqhdrugvzal')  # Hard-coded app password
        server.send_message(msg)
        print("Email sent successfully!")

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Send email with attachments')
    parser.add_argument('--sender', required=True)
    parser.add_argument('--receiver', required=True)
    parser.add_argument('--subject', required=True)
    parser.add_argument('--body', required=True)
    parser.add_argument('--files', nargs='+', required=True)
    
    args = parser.parse_args()

    try:
        send_email(
            sender_email=args.sender,
            receiver_email=args.receiver,
            subject=args.subject,
            body=args.body,
            attachments=args.files
        )
    except Exception as e:
        print(f"Error: {str(e)}", file=sys.stderr)
        sys.exit(1)
