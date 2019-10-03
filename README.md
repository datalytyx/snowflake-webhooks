# What is it?
An implementation to allow webhooks to be called from inside Snowflake to connect to external systems. This allows powerful bidirectional integration between Snowflake and other external systems.

# Why?
It is straightforward to make calls/trigger actions with Snowflake from any other systems and many processes/workflows make use of this. HoweverHowever, it is currently challenging to do the opposite - trigger actions/processes in other systems from within Snowflake.

## How could Webhooks be used? 
The use cases are wide and varied, anything from simple Email or SMS alerting from inside Snowflake (there are many services that will map an HTTP POST into an onward email or SMS message) to complex integration and orchestration with external systems.
If the information to be sent to the external system is small (e.g.e.g., an SMS message, an email message, a request for an orchestration job to run, etc.), then this can be sent in the payload of the HTTP message.
A good example of a more sophisticated use is bringing together tools like Talend and Snowflake with bidirectional orchestration. Orchestration from Talend can kick off long running jobs inside Snowflake without having to maintain a session, orsession or having to poll to find out if jobs have completed. When the work inside Snowflake has finished, a webhook call can be made back into Talend to start the next step in the process.

A similar example is with Databricks. Many customers hold data inside Snowflake for training models. When a critical mass of new data has been added, a retraining of a model within Databricks can be triggered.
If the amount of data to be processed is very large, then HTTP is not a good transport - millions of rows in an HTTP POST is not a good model!

This is exactly the use case we had when using the Gallium classifier on data inside Snowflake. In some cases organisations had Terabytes or even Petabytes of data thatey they wanted to process. This is a good example of a Data Service -– an organisation has some Data that they want processeding in some way, another organisation has a processing capability and Data Services is a great way to achieve this with Snowflake. One approach for this is Data Services using Data Sharing. Another approach is a more Direct Data Service where the Data Processing is done more directly on the customer’s data. Datalytyx built a working model of this using this web hook implementation and Table Streams (to do CDC). Using a scheduled Task within Snowflake we grab all the recently added data from the Table Stream, drop it into files on a stage and then send references to these files using webhooks to Gallium to be classified. Once the results are completed, they are put back into a stage and loaded using SnowPipe.

In general, almost anything that is achieved today with a system that does "poll Snowflake waiting for something to arrive or something to happen" can be replaced with Webhooks.


# Why Webhooks?
Webhooks are a very standard and well accepted way for web based or systems on the public internet to trigger each other when something happens. A webhook call is really just an HTTP call (usually a POST), so the target system doesn't have to support anything special - if they can be triggered with an HTTP GET or POST then it should work fine and this is almost universally supported by modern systems.

# Architecture
Since there is no ability to execute arbitrary code (or at least code that can talk out on a network) from within Snowflake, an alternative approach is required. Instead the approach we took in for this work is to create 'markers' from within Snowflake that an external system can pick up on and then action.

The architecture looks like:

![ScreenShot](snowflake-webhooks-architecture-image.png)

The logical flow is as follows:
* A call to  the ```call_webhook_sync``` or ```call_webhook_async``` procedures are called from anywhere inside Snowflake
* This creates a row in a metadata table in the ```WEBHOOK_METADATA``` (or whatever you define) database
* If the async method is being used, the function now returns with a unique webhook ID and execution of your code continues
* This also creates a file in the ```WEBHOOK_METADATA_OUT``` stage on S3
* The creation of this file triggers a Lambda function to execute
* This Lambda function does the actual work of calling the external webhook, passing the data and receiving the response. Note: this means the source address of the webhook call will be from the pool used by AWS Lambda, not Snowflake
* The Lambda function writes a file in the ```WEBHOOK_METADATA_IN```  stage and triggers a read from this
* This updates the row in the metadata table with various parameters e.g. the execution time, the HTTP response code and payload
* If the sync method is being used then the procedure has been polling the metadata table, waiting for the response information to appear (or a timeout to be hit) and then returns an object with the HTTP response code and payload


# Limitations
* This only works using AWS S3 and Lambda. All components (e.g. S3, Lamdba being used has equivalents in Azure and other Cloud Providers. Since the provision of this is done via using the serverless Application Framework, porting to other Cloud Providers should be straightforwards. Pull requests welcome!
* This code doesn't remove the temporary request and response files from the S3 bucket. If you want to clean these up this is left as a homework exercise.
* The reliability of the delivery from Snowflake to S3 to trigger the Lamda function is based on the reliability of S3 events. Nothing is provided beyond this at the application level.
* HTTP Verbs other than POST are technically supported but have not been extensively tested.
* WEBHOOK_RUNTIME is not currently populated but since the START and COMPLETE times are populated, this is trival to derive.


# Setup
In order to setup your system to run webhooks you will need:
* A Snowflake account including the SYSADMIN ROLE, etc.
* An AWS account with the following permissions to create IAM Roles, Lambda Functions, S3 Buckets, etc
* A machine to run the creation scripts from. This machine is only needed for setup, not for ongoing operation. This machine needs to have been setup for the AWS CLI including permissions.
* The Serverless Application Framework (usually ```npm install -g serverless``` if not check Serverless documentation).
* This repository (usually ```git clone https://github.com/datalytyx/snowflake-webhooks.git```).

# Installation
The installation uses templates version of a few creation scripts. The information specific to you needs to be added to the scripts and customised to your envrionment. You can do this by hand (not recommended!) or just setup your specific configuration with environment variables:

```
export SNOWFLAKE_METADATA_DATABASE="WEBHOOK_METADATA"
export SNOWFLAKE_METADATA_SCHEMA="PUBLIC"
export AWS_KEY_ID="<your aws key>"
export AWS_SECRET_KEY="<your aws secret>"
export AWS_S3_REGION="eu-west-1"
export S3_BUCKET="your_desired_s3_bucket_location"   # note this will be created for you and cannot already exist
```

Then use the following commands to convert the template files into ones personalised for you:
```
cat setup.sql.template | sed -e "s~{SNOWFLAKE_METADATA_DATABASE}~$SNOWFLAKE_METADATA_DATABASE~g" | sed -e "s~{SNOWFLAKE_METADATA_SCHEMA}~$SNOWFLAKE_METADATA_SCHEMA~g" | sed -e "s~{S3_BUCKET}~$S3_BUCKET~g" | sed -e "s~{AWS_KEY_ID}~$AWS_KEY_ID~g" | sed -e "s~{AWS_SECRET_KEY}~$AWS_SECRET_KEY~g" > setup.sql

cat serverless.yaml.template | sed -e "s~{S3_BUCKET}~$S3_BUCKET~g" > serverless.yaml

cat lambda.js.template  | sed -e "s~{AWS_S3_REGION}~$AWS_S3_REGION~g" > lambda.js
```

## Setup lambda functions and triggers from S3 bucket
Assuming you already have your AWS credentials setup using ```aws configure```, all you need to do is run:

```
serverless deploy
```

Alternatively - you can namespace this by using the ```--stage <stagename>``` flag. See serverless documentation for more details.

## Setting up Snowflake
While you can execute the contents of ```setup.sql``` from the CLI (e.g. using snowsql), since this is only a one time setup script the easiest thing to do is to simply open up a Snowflake workbook in your browser, paste the contents of setup.sql in and execute. 

In the Workbench be sure to use the SYSADMIN role and set a warehouse just to run the setup script as. Note that the execution for the webhook procedures themselves will be using whichever user, role and warehouse the calling code is using i.e. the procedures don't change any of these.

Leave a Snowflake workbook open for testing next. 

After executing this script you will need to grant SELECT and UPDATE privileges to this database to ROLES that you want to be able to call webhooks.

## Testing
A simple way is to use https://webhook.site/ - it will give you a test URL like ```https://webhook.site/38c60cba-dc45-424e-9f9a-f8e83fa0dc4f``` that you can use to test webhooks, check they are being called correctly and set payload responses for testing.

To test that everything is working run the following in Snowflake

```
set myid='anything I want, this is just for me'; 
set payload='THIS IS A TEST';
set good_webhook_url='https://webhook.site/<yoururl>';
set notfound_webhook_url='https://google.com/iamnotavalidpath';
set bad_webhook_url='https://iamnotavalidurl.com';
```

Be sure to set your good_webhook_url to the one you created yourself at webhook.site

You can then run the following test cases:

```
call call_webhook_async ($myid,$good_webhook_url,'POST',$payload);
call call_webhook_async ($myid,$notfound_webhook_url,'POST',$payload);
call call_webhook_async ($myid,$bad_webhook_url,'POST',$payload);
```

You should see a response pretty quickly that says:

```
Webhook sucessfully registered for execution
```

This means that a row has been written to the SNOWFLAKE_METADATA_DATABASE you defined and a file has been created in the S3 bucket. Assuming the Lambda function has been setup correctly the writing of this file will trigger the Lamba function. The AWS Lambda pages provide excellent functionality to check that jobs have been executed, whether they ran successfully or not and see the logs for the function. You can also get these logs streamed to you in real-time (with some delay) by running:

```
serverless logs --function callWebhook --tail
```
Which is very useful for debugging.


The following sync calls DO return different results:

```
call call_webhook_sync ($myid,$good_webhook_url,'POST',$payload);
```

should give a response like:

```
{"httpStatusCode":"200","body":"HELLO"}
```

Where ```HELLO``` was the HTTP Response I setup when I created my URL at webhook.site

```
call call_webhook_sync ($myid,$notfound_webhook_url,'POST',$payload);
```
should give a response like:

```
{"httpStatusCode":"404","body":"<!DOCTYPE html>
<html lang=en>
  <meta charset=utf-8>
  <meta name=viewport content="initial-scale=1, minimum-scale=1, width=device-width">
  <title>Error 404 (Not Found)!!1</title>
  <style>
    *{margin:0;padding:0}html,code{font:15px/22px arial,sans-serif}html{background:#fff;color:#222;padding:15px}body{margin:7% auto 0;max-width:390px;min-height:180px;padding:30px 0 15px}* > body{background:url(//www.google.com/images/errors/robot.png) 100% 5px no-repeat;padding-right:205px}p{margin:11px 0 22px;overflow:hidden}ins{color:#777;text-decoration:none}a img{border:0}@media screen and (max-width:772px){body{background:none;margin-top:0;max-width:none;padding-right:0}}#logo{background:url(//www.google.com/images/branding/googlelogo/1x/googlelogo_color_150x54dp.png) no-repeat;margin-left:-5px}@media only screen and (min-resolution:192dpi){#logo{background:url(//www.google.com/images/branding/googlelogo/2x/googlelogo_color_150x54dp.png) no-repeat 0% 0%/100% 100%;-moz-border-image:url(//www.google.com/images/branding/googlelogo/2x/googlelogo_color_150x54dp.png) 0}}@media only screen and (-webkit-min-device-pixel-ratio:2){#logo{background:url(//www.google.com/images/branding/googlelogo/2x/googlelogo_color_150x54dp.png) no-repeat;-webkit-background-size:100% 100%}}#logo{display:inline-block;height:54px;width:150px}
  </style>
  <a href=//www.google.com/><span id=logo aria-label=Google></span></a>
  <p><b>404.</b> <ins>That’s an error.</ins>
  <p>The requested URL <code>/iamnotavalidpath</code> was not found on this server.  <ins>That’s all we know.</ins>
"}
```


```
call call_webhook_sync ($myid,$bad_webhook_url,'POST',$payload);
``` 

should give a response like:

```
{"httpStatusCode":"520","body":"{"code":"ENOTFOUND","errno":"ENOTFOUND","host":"iamnotavalidurl.com","hostname":"iamnotavalidurl.com","port":443,"syscall":"getaddrinfo"}"}
```


At the end of these 6 tests, if you look at the raw log table:

```select * from <your log table>;```

![ScreenShot](query_results_webhook.JPG)

If the valid calls to the good url have worked you should also see them pop up in webhook.site e.g.

![ScreenShot](webhook_site.JPG)

## Common faults
If you run a sync call and see a response 

```{"httpStatusCode":"520","body":"An unknown error has occured"}```

The most likely cause is the Lambda function is not deployed correctly.

# Uninstall
Delete all the files in your S3 bucket (if not, the serverless remove will fail and could leave your system in partially deleted state) then run

```
serverless remove
```

Which will delete the S3 bucket, the lamba functions and the triggers, IAM roles etc.

Then you should drop the schema and database you created in Snowflake and everything will be removed.

