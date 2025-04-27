from flask import Flask, request, jsonify
from flask_cors import CORS
import smtplib
import ssl
import os
import certifi
from email.message import EmailMessage
import tempfile

app = Flask(__name__)
CORS(app)

# Email configuration
SENDER_EMAIL = 'Shovan.rautt@gmail.com'
APP_PASSWORD = 'mrfqywqhdrugvzal'  # Consider moving this to environment variables
DOCTOR_EMAIL = 'doctor@example.com'  # Use the email from your React component

def send_email_with_attachments(attachments_data):
    """
    Send email with attachments using Gmail SMTP
    
    :param attachments_data: List of dictionaries containing blob and filename
    """
    msg = EmailMessage()
    msg['From'] = SENDER_EMAIL
    msg['To'] = DOCTOR_EMAIL
    msg['Subject'] = 'Health Reports'
    msg.set_content('Please find attached your health reports.\n\nBest regards.')

    # Create temporary files and attach them
    temp_files = []
    try:
        for attachment in attachments_data:
            # Create temporary file
            temp_file = tempfile.NamedTemporaryFile(delete=False)
            temp_files.append(temp_file.name)
            
            # Write blob data to temporary file
            temp_file.write(attachment['blob'])
            temp_file.close()
            
            # Attach file to email
            with open(temp_file.name, 'rb') as f:
                file_data = f.read()
                msg.add_attachment(
                    file_data,
                    maintype='application',
                    subtype='octet-stream',
                    filename=attachment['filename']
                )

        # Create SSL context using certifi's bundle
        context = ssl.create_default_context(cafile=certifi.where())

        # Send email
        with smtplib.SMTP_SSL('smtp.gmail.com', 465, context=context) as server:
            server.login(SENDER_EMAIL, APP_PASSWORD)
            server.send_message(msg)
            
        return True, "Email sent successfully!"
    
    except Exception as e:
        return False, f"Failed to send email: {str(e)}"
    
    finally:
        # Clean up temporary files
        for temp_file in temp_files:
            try:
                os.unlink(temp_file)
            except:
                pass

@app.route('/api/reports/email', methods=['POST'])
def email_reports():
    try:
        # Get files from request
        if 'reports' not in request.files:
            return jsonify({'error': 'No files provided'}), 400

        attachments_data = []
        files = request.files.getlist('reports')
        
        for file in files:
            attachments_data.append({
                'blob': file.read(),
                'filename': file.filename
            })

        # Send email with attachments
        success, message = send_email_with_attachments(attachments_data)
        
        if success:
            return jsonify({'message': message}), 200
        else:
            return jsonify({'error': message}), 500

    except Exception as e:
        return jsonify({'error': f'Server error: {str(e)}'}), 500

# Your existing routes and code here...

if __name__ == '__main__':
    app.run(port=3001, debug=True)