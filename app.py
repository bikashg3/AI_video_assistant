from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
import aiohttp
import json
import time
import random
import ast
import urllib.parse
from apscheduler.schedulers.background import BackgroundScheduler
import os
from pydantic import BaseModel

SAMBA_NOVA_API_KEY = os.environ.get("SAMBA_NOVA_API_KEY", None)

app = FastAPI()

# Time-Limited Infinite Cache
cache = {}
CACHE_DURATION = 120

# Function to clean up expired cache entries
def cleanup_cache():
    current_time = time.time()
    for key, (value, timestamp) in list(cache.items()):
        if current_time - timestamp > CACHE_DURATION:
            del cache[key]

# Initialize and start the scheduler
scheduler = BackgroundScheduler()
scheduler.add_job(cleanup_cache, 'interval', seconds=60)  # Run cleanup every 60 seconds
scheduler.start()

class StreamTextRequest(BaseModel):
    query: str
    history: str = "[]"
    model: str = "llama3-8b"
    api_key: str = None

@app.post("/stream_text")
async def stream_text(request: StreamTextRequest):
    current_time = time.time()
    cache_key = (request.query, request.history, request.model)

    # Check if the request is in the cache and not expired
    if cache_key in cache:
        cached_response, timestamp = cache[cache_key]
        return StreamingResponse(iter([f"{cached_response}"]), media_type='text/event-stream')

    # Model selection logic
    if "405" in request.model:
        fmodel = "Meta-Llama-3.1-405B-Instruct"
    if "70" in request.model:
        fmodel = "Meta-Llama-3.1-70B-Instruct"
    else:
        fmodel = "Meta-Llama-3.1-8B-Instruct"

    system_message = """You are a friendly and intelligent video chat assistant created by Bikash Gupta. Your goal is to provide accurate, concise, and engaging responses with a positive tone. Deliver clear information that directly addresses user queries, and sprinkle in some humor—laughter is the best app! Use context from live images to enrich your responses and personalize the experience. Keep answers brief and to the point, avoiding unnecessary details unless they’re hilariously relevant. Maintain a friendly demeanor and don’t hesitate to use a cheeky pun! Encourage follow-up questions to foster smooth conversations. Aim to make the user smile and offer additional help or suggestions as needed. Remember, you’re here to assist with charm and clarity—stay focused, stay concise."""

    messages = [{'role': 'system', 'content': system_message}]

    messages.extend(ast.literal_eval(request.history))

    messages.append({'role': 'user', 'content': request.query})
    
    data = {'messages': messages, 'stream': True, 'model': fmodel}

    api_key = request.api_key if request.api_key != 'none' else SAMBA_NOVA_API_KEY


    async def stream_response():
        async with aiohttp.ClientSession() as session:
            async with session.post('https://api.sambanova.ai/v1/chat/completions', headers = { 'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json' }, json=data) as response:
                if response.status != 200:
                    raise HTTPException(status_code=response.status, detail="Error fetching AI response")

                response_content = ""
                async for line in response.content:
                    line = line.decode('utf-8').strip()
                    if line.startswith('data: {'):
                        json_data = line[6:]
                        try:
                            parsed_data = json.loads(json_data)
                            content = parsed_data.get("choices", [{}])[0].get("delta", {}).get("content", '')
                            if content:
                                content = content.replace("\n", " ")
                                response_content += f"data: {content}\n\n"
                                yield f"data: {content}\n\n"
                        except json.JSONDecodeError as e:
                            print(f"Error decoding JSON: {e}")
                            yield f"data: Error decoding JSON\n\n"

                # Cache the full response
                cache[cache_key] = (response_content, current_time)

    return StreamingResponse(stream_response(), media_type='text/event-stream')



# Serve index.html from the same directory as your main.py file 
from starlette.responses import FileResponse 

@app.get("/script1.js")
async def script1_js():
    return FileResponse("script1.js")

@app.get("/script2.js")
async def script2_js():
    return FileResponse("script2.js")

@app.get("/styles.css")
async def styles_css():
    return FileResponse("styles.css")

@app.get("/")
async def read_index():
    return FileResponse('index.html')

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=7068, reload=True)
